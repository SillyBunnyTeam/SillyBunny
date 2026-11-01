import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import sharp from 'sharp';
import { assertWithinCap, estimateBatch } from './cost.mjs';
import { buildContactSheet } from './contact-sheet.mjs';
import { requireKey } from './env.mjs';
import { sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, readLog, runningTotalUsd, sha256 } from './log.mjs';
import { buildPatchRequest, compositeOnto, differenceReport, extractPatchResult, parsePatchSpec } from './patch.mjs';
import { composePrompt } from './prompt-kit.mjs';
import { createProvider, describePlan } from './providers.mjs';
import { crop as cropRaster, readRaster } from './raster.mjs';
import { redactText } from './redact.mjs';
import { resolveModel, resolveOutDir, tryBalance, usd } from './run.mjs';

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
 * @property {number} n Variants per patch.
 * @property {string} outDir Must resolve inside raw/ or out/.
 * @property {string} stage
 * @property {number} feather Width in pixels of the soft edge of each composite rect.
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
    const { rootDir, config, kit, env, fetchImpl, confirm, now } = deps;
    const knownSecrets = Object.values(env).map((settings) => settings.apiKey);
    const say = (line) => deps.print(redactText(line, knownSecrets));

    const { model, provider: providerName, warning } = resolveModel(config, request);
    if (providerName !== 'openai') {
        throw new Error(`patch.mjs sends /images/edits, which only the OpenAI provider supports here; "${model}" belongs to ${providerName}.`);
    }
    const outDir = resolveOutDir(rootDir, request.outDir);
    const sourceBytes = readFileSync(request.imagePath);
    sniffImage(sourceBytes);
    const sourceHash = sha256(sourceBytes);
    const source = await readRaster(request.imagePath);
    const patches = parsePatchSpec(request.patches, source);

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
    const sourceLabel = relative(rootDir, request.imagePath).startsWith('..') ? basename(request.imagePath) : relative(rootDir, request.imagePath).split(sep).join('/');

    if (warning) {
        say(warning);
    }
    say(`${providerName} / ${model}   template: patch-edit   stage: ${request.stage}`);
    say(`source: ${sourceLabel}  ${source.width}x${source.height}  sha256 ${sourceHash.slice(0, 16)}`);
    say(`patches: ${prepared.length}   calls: ${callCount} (${request.n} per patch)   references: 1 (the crop of each patch)`);
    for (const item of prepared) {
        say(`patch ${item.number}: crop ${rectText(item.crop)} -> ${item.picture.size} (${item.picture.scale.toFixed(2)}x)  padding ${hexOf(item.picture.background)}  composite ${rectList(item.composite)}  feather ${request.feather}`);
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

    const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const stem = `${stamp}-${model}-patch`;
    mkdirSync(outDir, { recursive: true });
    const fileEntry = (path, bytes) => ({ file: relative(rootDir, path).split(sep).join('/'), sha256: sha256(bytes) });

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
                    chargedUsd = units >= 0 ? Math.round((units / config.pricing.unitsPerUsd) * 1e6) / 1e6 : undefined;
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
    const stopped = await makeCalls();

    for (let variant = 1; variant <= request.n; variant++) {
        if (!prepared.every((item) => results.has(`${item.number}:${variant}`))) {
            continue;
        }
        const merged = { ...source, data: Buffer.from(source.data) };
        for (const item of prepared) {
            compositeOnto(merged, results.get(`${item.number}:${variant}`), item.crop, item.composite, request.feather);
        }
        const png = await toPng(merged);
        const path = join(outDir, `${stem}-${variant}.png`);
        writeFileSync(path, png, { flag: 'wx' });
        const panels = [];
        for (const item of prepared) {
            panels.push({ image: await toPng(cropRaster(source, item.crop)), label: `p${item.number} before` });
            panels.push({ image: await toPng(cropRaster(merged, item.crop)), label: `p${item.number} after` });
        }
        const sheet = await buildContactSheet(panels, { cols: 2, cellWidth: 0, cellHeight: 0, gap: 12, labelHeight: 24, nearest: true, scales: [2] });
        writeFileSync(join(outDir, `${stem}-${variant}-compare.png`), sheet, { flag: 'wx' });
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
                patches: prepared.map((item) => ({ crop: rectArray(item.crop), composite: item.composite.map(rectArray), instruction: item.instruction })),
            },
            refHashes: [sourceHash],
            size: `${merged.width}x${merged.height}`,
            outputs: [fileEntry(path, png)],
            estimatedUsd: 0,
        }));
        say(`saved ${fileEntry(path, png).file}`);
        say(`before and after at 2x: ${fileEntry(join(outDir, `${stem}-${variant}-compare.png`), sheet).file}`);
    }

    if (stopped) {
        if (calls === 0) {
            throw new Error(`No images were made: ${stopped}`);
        }
        say(`STOPPED after ${calls} of ${callCount} calls: ${stopped}`);
    }
    return { dryRun: false, partial: Boolean(stopped), calls };
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
