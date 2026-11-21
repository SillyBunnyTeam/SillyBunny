import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { assertWithinCap, estimateBatch } from './cost.mjs';
import { buildContactSheet } from './contact-sheet.mjs';
import { requireKey } from './env.mjs';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, readLog, runningTotalUsd, sha256 } from './log.mjs';
import { buildPatchRequest, compositeOnto, countNewlyOpaque, differenceReport, extractPatchResult, parsePatchSpec } from './patch.mjs';
import { loadReusedRun } from './patch-reuse.mjs';
import { composePrompt } from './prompt-kit.mjs';
import { createProvider, describePlan } from './providers.mjs';
import { crop as cropRaster, readRaster } from './raster.mjs';
import { redactText } from './redact.mjs';
import { resolveModel, resolveOutDir, tryBalance, usd, warnIfOverlapped } from './run.mjs';
import { endRun, startRun } from './token-runs.mjs';

// Mean colour difference (0-255) outside the composite rects above which the model has probably redrawn more than asked.
const OUTSIDE_WARN = 10;

const rectText = (rect) => `[${rect.x},${rect.y},${rect.width},${rect.height}]`;
const rectList = (rects) => `[${rects.map(rectText).join(',')}]`;
const rectArray = (rect) => [rect.x, rect.y, rect.width, rect.height];
const hexOf = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
const toPng = (raster) => sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } }).png().toBuffer();

/**
 * @typedef {object} PatchRequest
 * @property {string} imagePath The picture to patch (an approved or raw PNG).
 * @property {any} patches The parsed patches.json.
 * @property {string} [instruction] Default instruction for patches that have none of their own.
 * @property {string} [model]
 * @property {number} n Variants per patch. Not used with `reuse`, where the reused run decides.
 * @property {string} [reuse] Run prefix of an earlier run (its raw/.../<stamp>-<model>-patch) whose model results are composited again instead of calling the model.
 * @property {string} outDir Must resolve inside raw/ or out/.
 * @property {string} stage
 * @property {number} feather Width in pixels of the soft edge of each composite rect.
 * @property {boolean} [keepAlpha] Keep the source's alpha inside the composite rects: only solid source pixels (alpha 250 or more) take the result's colour.
 * @property {boolean} allowUnlocked
 * @property {boolean} dryRun
 * @property {boolean} yes
 * @property {boolean} balance
 */

/**
 * Edits small parts of a picture one crop at a time, so the model works on an enlarged view of just that part,
 * and puts only the chosen rects back. One model call per patch and variant.
 * @param {PatchRequest} request
 * @param {import('./run.mjs').RunDeps} deps
 */
export async function runPatches(request, deps) {
    if (request.reuse) {
        return reusePatches(request, deps);
    }
    const { rootDir, config, kit, env, fetchImpl, confirm, now } = deps;
    const say = sayFor(deps);

    const { model, provider: providerName, warning } = resolveModel(config, request);
    if (providerName !== 'openai') {
        throw new Error(`patch.mjs sends /images/edits, which only the OpenAI provider supports here; "${model}" belongs to ${providerName}.`);
    }
    const outDir = resolveOutDir(rootDir, request.outDir);
    const { sourceHash, source, patches, sourceLabel } = await readSource(rootDir, request);

    const prepared = [];
    for (const [index, patch] of patches.entries()) {
        const number = index + 1;
        const instruction = patch.instruction ?? request.instruction;
        if (!instruction) {
            throw new Error(`Patch ${number} has no instruction. Pass --instruction, or give the patch its own in the spec.`);
        }
        const { prompt } = composePrompt(kit, 'patch-edit', { vars: { instruction }, refCount: 1 });
        prepared.push({ ...patch, number, instruction, prompt, picture: await buildPatchRequest(source, patch.crop) });
    }

    const provider = createProvider(providerName, {
        apiKey: env[providerName].apiKey ?? '',
        baseUrl: env[providerName].baseUrl,
        fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        sleep: deps.sleep,
        onRetry: (message) => say(`retry: ${message}`),
    });
    const jobFor = (item) => ({
        model,
        prompt: item.prompt,
        refs: [{ bytes: item.picture.png, mime: 'image/png', filename: `patch-${item.number}.png` }],
        size: item.picture.size,
        n: 1,
    });
    for (const item of prepared) {
        provider.validate(jobFor(item));
    }

    const perCallUsd = prepared.map((item) => estimateBatch(config, { model, n: 1, size: item.picture.size, promptChars: item.prompt.length, refCount: 1 }).perImageUsd);
    const callCount = prepared.length * request.n;
    const totalUsd = Math.round(perCallUsd.reduce((sum, value) => sum + value, 0) * request.n * 1e6) / 1e6;
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const runningUsd = runningTotalUsd(readLog(logPath));

    if (warning) {
        say(warning);
    }
    say(`${providerName} / ${model}   template: patch-edit   stage: ${request.stage}`);
    say(`source: ${sourceLabel}  ${source.width}x${source.height}  sha256 ${sourceHash.slice(0, 16)}`);
    say(`patches: ${prepared.length}   calls: ${callCount} (${request.n} per patch)   references: 1 (the crop of each patch)`);
    for (const item of prepared) {
        say(`patch ${item.number}: crop ${rectText(item.crop)} -> ${item.picture.size} (${item.picture.scale.toFixed(2)}x)  padding ${hexOf(item.picture.background)}  composite ${rectList(item.composite)}  feather ${request.feather}${request.keepAlpha ? '  keep-alpha' : ''}`);
        say(`  instruction: ${item.instruction}`);
        if (item.picture.tooSmall) {
            say(`  WARNING: the crop is small, so the model sees it magnified ${item.picture.scale.toFixed(0)}x and mostly smoothed pixels. A larger crop may work better.`);
        }
    }
    say(`estimate: ${callCount} x ${usd(totalUsd / callCount)} = ${usd(totalUsd)}`);
    say(`logged so far: ${usd(runningUsd)}   cap: ${usd(config.costCapUsd)}`);

    if (request.dryRun) {
        const projected = Math.round((runningUsd + totalUsd) * 1e6) / 1e6;
        say(projected > config.costCapUsd ? `WOULD REFUSE: ${usd(projected)} passes the cap.` : `within cap: ${usd(projected)} after this run.`);
        let shown;
        for (const item of prepared) {
            say(`--- prompt (patch ${item.number}) ---${item.prompt === shown ? ' same as the previous patch' : `\n${item.prompt}`}`);
            shown = item.prompt;
        }
        say('--- request for patch 1 (credentials redacted, image bytes elided; other patches differ in prompt, image and size) ---');
        say(JSON.stringify(describePlan(provider.plan(jobFor(prepared[0]))), null, 2));
        say('dry run: nothing was sent, saved or logged.');
        return { dryRun: true, totalUsd, callCount };
    }

    requireKey(env[providerName], providerName);
    assertWithinCap(config, { runningUsd, batchUsd: totalUsd });
    const approved = request.yes || await confirm(`Send ${callCount} edit call${callCount > 1 ? 's' : ''} for ${usd(totalUsd)} to ${new URL(env[providerName].baseUrl).host}?`);
    if (!approved) {
        throw new Error('Cancelled. Nothing was sent.');
    }

    const stem = runStem(now, model);
    mkdirSync(outDir, { recursive: true });
    const fileEntry = (path, bytes) => fileEntryOf(rootDir, path, bytes);

    const tokenRun = startRun({ rootDir, provider: providerName, now });
    let balanceBefore = request.balance ? await tryBalance({ say, env, providerName, config, fetchImpl }) : undefined;
    /** results.get(`${patch}:${variant}`) is the model's crop, scaled back to the crop size */
    const results = new Map();
    let calls = 0;

    /** Makes every call in order; returns why it stopped early, or undefined when all calls finished. */
    const makeCalls = async () => {
        for (const item of prepared) {
            writeFileSync(join(outDir, `${stem}-p${item.number}.prompt.txt`), `${item.prompt}\n`, { flag: 'wx' });
            writeFileSync(join(outDir, `${stem}-p${item.number}.request.png`), item.picture.png, { flag: 'wx' });
            const before = cropRaster(source, item.crop);
            for (let variant = 1; variant <= request.n; variant++) {
                const label = `patch ${item.number} variant ${variant}`;
                const reply = await provider.generate(jobFor(item));
                if (reply.images.length === 0) {
                    return `${label}: ${reply.error ?? 'the model returned no image'}`;
                }
                const bytes = reply.images[0].bytes;
                const path = join(outDir, `${stem}-p${item.number}-${variant}.${sniffImage(bytes).ext}`);
                writeFileSync(path, bytes, { flag: 'wx' });
                say(`saved ${fileEntry(path, bytes).file}`);
                for (const usage of reply.usage) {
                    say(`usage: ${JSON.stringify(usage)}`);
                }

                let chargedUsd;
                if (balanceBefore) {
                    const after = await tryBalance({ say, env, providerName, config, fetchImpl });
                    const units = after ? after.totalUsedUnits - balanceBefore.totalUsedUnits : -1;
                    const overlapped = units >= 0 && warnIfOverlapped({ say, tokenRun, now, spentUsd: perCallUsd[item.number - 1] });
                    chargedUsd = units >= 0 && !overlapped ? Math.round((units / config.pricing.unitsPerUsd) * 1e6) / 1e6 : undefined;
                    if (chargedUsd !== undefined) {
                        say(`relay charged ${usd(chargedUsd)} (${units} units); estimate was ${usd(perCallUsd[item.number - 1])}`);
                    }
                    balanceBefore = after ?? balanceBefore;
                }
                appendLogEntry(logPath, makeLogEntry({
                    time: now().toISOString(),
                    stage: request.stage,
                    provider: providerName,
                    model,
                    template: 'patch-edit',
                    vars: {
                        instruction: item.instruction,
                        source: sourceLabel,
                        patch: item.number,
                        variant,
                        crop: rectArray(item.crop),
                        composite: item.composite.map(rectArray),
                        feather: request.feather,
                    },
                    refHashes: [sourceHash],
                    size: item.picture.size,
                    outputs: [fileEntry(path, bytes)],
                    estimatedUsd: perCallUsd[item.number - 1],
                    chargedUsd,
                }));
                calls++;

                try {
                    const extracted = await extractPatchResult(bytes, item.picture, item.crop);
                    extracted.warnings.forEach((text) => say(`WARNING: ${label}: ${text}`));
                    results.set(`${item.number}:${variant}`, extracted.raster);
                    reportDifference({ say, label, before, after: extracted.raster, item });
                } catch (error) {
                    return `${label}: ${error.message}`;
                }
            }
        }
        return undefined;
    };
    let stopped;
    try {
        stopped = await makeCalls();
    } finally {
        endRun(tokenRun, { now });
    }

    await writeComposites(
        { say, rootDir, logPath, outDir, stem, request, providerName, model, now, source, sourceLabel },
        { prepared, results, variants: request.n, refHashesFor: () => [sourceHash], extraVars: {} },
    );

    if (stopped) {
        if (calls === 0) {
            throw new Error(`No images were made: ${stopped}`);
        }
        say(`STOPPED after ${calls} of ${callCount} calls: ${stopped}`);
    }
    return { dryRun: false, partial: Boolean(stopped), calls };
}

/**
 * Composites the saved model results of an earlier run again with this spec's composite rects and --feather.
 * The crops must be the ones the results were made for, so the request pictures (and with them the way each result
 * is scaled back) come out the same. No model call is made and nothing is charged.
 * @param {PatchRequest} request
 * @param {import('./run.mjs').RunDeps} deps
 */
async function reusePatches(request, deps) {
    const { rootDir, now } = deps;
    const say = sayFor(deps);
    const outDir = resolveOutDir(rootDir, request.outDir);
    const { sourceHash, source, patches, sourceLabel } = await readSource(rootDir, request);
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const reused = loadReusedRun({ rootDir, logPath, prefix: request.reuse, sourceHash, crops: patches.map((patch) => rectArray(patch.crop)) });

    const prepared = [];
    for (const [index, patch] of patches.entries()) {
        prepared.push({ ...patch, number: index + 1, instruction: reused.instructions[index], picture: await buildPatchRequest(source, patch.crop) });
    }
    say(`reusing ${reused.prefix}   ${reused.provider} / ${reused.model}   template: patch-composite   stage: ${request.stage}`);
    say(`source: ${sourceLabel}  ${source.width}x${source.height}  sha256 ${sourceHash.slice(0, 16)}`);
    say(`patches: ${prepared.length}   variants: ${reused.variants}   model calls: 0   cost: ${usd(0)}`);

    const results = new Map();
    for (const item of prepared) {
        say(`patch ${item.number}: crop ${rectText(item.crop)}  composite ${rectList(item.composite)}  feather ${request.feather}${request.keepAlpha ? '  keep-alpha' : ''}`);
        const before = cropRaster(source, item.crop);
        for (let variant = 1; variant <= reused.variants; variant++) {
            const key = `${item.number}:${variant}`;
            const label = `patch ${item.number} variant ${variant}`;
            const saved = reused.results.get(key);
            say(`  variant ${variant}: ${saved.file}  sha256 ${saved.sha256.slice(0, 16)}`);
            try {
                const extracted = await extractPatchResult(saved.bytes, item.picture, item.crop);
                extracted.warnings.forEach((text) => say(`WARNING: ${label}: ${text}`));
                results.set(key, extracted.raster);
                reportDifference({ say, label, before, after: extracted.raster, item });
            } catch (error) {
                throw new Error(`${label}: ${error.message}`);
            }
        }
    }

    if (request.dryRun) {
        for (let variant = 1; variant <= reused.variants; variant++) {
            compositeVariant({ say, request, source, prepared, results, variant });
        }
        say('dry run: nothing was saved or logged.');
        return { dryRun: true, totalUsd: 0, callCount: 0 };
    }

    mkdirSync(outDir, { recursive: true });
    await writeComposites(
        { say, rootDir, logPath, outDir, stem: runStem(now, reused.model), request, providerName: reused.provider, model: reused.model, now, source, sourceLabel },
        {
            prepared,
            results,
            variants: reused.variants,
            refHashesFor: (variant) => [sourceHash, ...prepared.map((item) => reused.results.get(`${item.number}:${variant}`).sha256)],
            extraVars: { reused: reused.prefix },
        },
    );
    return { dryRun: false, partial: false, calls: 0 };
}

const sayFor = (deps) => {
    const knownSecrets = Object.values(deps.env).map((settings) => settings.apiKey);
    return (line) => deps.print(redactText(line, knownSecrets));
};

/** Reads and parses the inputs every run starts from: the picture, its hash, the trusted patches and the name the log uses for the picture. */
async function readSource(rootDir, request) {
    const sourceBytes = readFileSync(request.imagePath);
    sniffImage(sourceBytes);
    const source = await readRaster(request.imagePath);
    const patches = parsePatchSpec(request.patches, source);
    const inRoot = relative(rootDir, request.imagePath);
    const sourceLabel = inRoot.startsWith('..') ? basename(request.imagePath) : inRoot.split(sep).join('/');
    return { sourceHash: sha256(sourceBytes), source, patches, sourceLabel };
}

/** The file-name stem shared by everything one run writes. */
function runStem(now, model) {
    const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    return `${stamp}-${model}-patch`;
}

const fileEntryOf = (rootDir, path, bytes) => ({ file: relative(rootDir, path).split(sep).join('/'), sha256: sha256(bytes) });

/**
 * Writes, for every variant that has a result for every patch, the full-size picture and its before and after sheet,
 * and logs the picture as a `patch-composite` at no cost so `approve.mjs` can approve it.
 * `refHashesFor(variant)` gives the log line's `refs`; `extraVars` is added to its `vars`.
 */
async function writeComposites(run, { prepared, results, variants, refHashesFor, extraVars }) {
    const { say, rootDir, logPath, outDir, stem, request, providerName, model, now, source, sourceLabel } = run;
    for (let variant = 1; variant <= variants; variant++) {
        if (!prepared.every((item) => results.has(`${item.number}:${variant}`))) {
            continue;
        }
        const { merged, newlyOpaque } = compositeVariant({ say, request, source, prepared, results, variant });
        const png = await toPng(merged);
        const path = join(outDir, `${stem}-${variant}.png`);
        writeFileSync(path, png, { flag: 'wx' });
        const panels = [];
        for (const item of prepared) {
            panels.push({ image: await toPng(cropRaster(source, item.crop)), label: `p${item.number} before` });
            panels.push({ image: await toPng(cropRaster(merged, item.crop)), label: `p${item.number} after` });
        }
        const sheet = await buildContactSheet(panels, { cols: 2, cellWidth: 0, cellHeight: 0, gap: 12, labelHeight: 24, nearest: true, scales: [2] });
        const sheetPath = join(outDir, `${stem}-${variant}-compare.png`);
        writeFileSync(sheetPath, sheet, { flag: 'wx' });
        appendLogEntry(logPath, makeLogEntry({
            time: now().toISOString(),
            stage: request.stage,
            provider: providerName,
            model,
            template: 'patch-composite',
            vars: {
                source: sourceLabel,
                variant,
                feather: request.feather,
                ...(request.keepAlpha ? { keepAlpha: true } : {}),
                newlyOpaque,
                ...extraVars,
                patches: prepared.map((item) => ({ crop: rectArray(item.crop), composite: item.composite.map(rectArray), instruction: item.instruction })),
            },
            refHashes: refHashesFor(variant),
            size: `${merged.width}x${merged.height}`,
            outputs: [fileEntryOf(rootDir, path, png)],
            estimatedUsd: 0,
        }));
        say(`saved ${fileEntryOf(rootDir, path, png).file}`);
        say(`before and after at 2x: ${fileEntryOf(rootDir, sheetPath, sheet).file}`);
    }
}

/**
 * Builds the full-size picture of one variant from its results, and says how many pixels the model made visible in what was
 * transparent space in the source (`newlyOpaque`). That count is printed whether or not `--keep-alpha` is set; without it a count
 * above 0 is also a warning, because it is what shows as a coloured box around a sticker.
 */
function compositeVariant({ say, request, source, prepared, results, variant }) {
    const merged = { ...source, data: Buffer.from(source.data) };
    for (const item of prepared) {
        compositeOnto(merged, results.get(`${item.number}:${variant}`), item.crop, item.composite, request.feather, { keepAlpha: Boolean(request.keepAlpha) });
    }
    const newlyOpaque = countNewlyOpaque(source, merged, prepared.map((item) => item.composite));
    say(`variant ${variant}: ${newlyOpaque} pixels inside the composite rects were transparent in the source and are not now`);
    if (newlyOpaque > 0 && !request.keepAlpha) {
        say(`WARNING: variant ${variant}: ${newlyOpaque} transparent pixels of the source became visible, which shows as a box of the model's background around the sticker. Pass --keep-alpha to keep the source's transparency inside the rects.`);
    }
    return { merged, newlyOpaque };
}

function reportDifference({ say, label, before, after, item }) {
    const rects = item.composite.map((rect) => ({ x: rect.x - item.crop.x, y: rect.y - item.crop.y, width: rect.width, height: rect.height }));
    const report = differenceReport(before, after, rects);
    const outside = report.outside === undefined ? 'no area outside' : report.outside.toFixed(1);
    say(`${label}: mean colour difference inside the composite area ${report.inside.toFixed(1)}, outside it ${outside}`);
    if (report.outside > OUTSIDE_WARN) {
        say(`WARNING: ${label}: the model changed the area outside the composite rects (mean difference ${report.outside.toFixed(1)}). That area is not used, but check the before and after sheet in case it redrew more than you asked for.`);
    }
}
