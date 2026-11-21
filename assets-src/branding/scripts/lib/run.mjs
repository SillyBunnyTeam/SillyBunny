import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readBalance } from './balance.mjs';
import { resolveBackground } from './background.mjs';
import { assertWithinCap, estimateBatch } from './cost.mjs';
import { requireKey } from './env.mjs';
import { pngHasAlpha, readReference, sniffImage } from './images.mjs';
import { appendLogEntry, makeLogEntry, readLog, runningTotalUsd, sha256 } from './log.mjs';
import { composePrompt } from './prompt-kit.mjs';
import { createProvider, describePlan } from './providers.mjs';
import { redactText } from './redact.mjs';
import { endRun, otherRunsDuring, startRun } from './token-runs.mjs';

const DEFAULT_SIZES = { openai: '1024x1024', gemini: '1K' };

export const usd = (value) => {
    const cents = value.toFixed(2);
    return `$${Number(cents) === Number(value.toFixed(4)) ? cents : value.toFixed(4)}`;
};

/**
 * The shared run: compose, price, confirm, call the provider, save, log.
 * `generate.mjs` and `edit.mjs` only differ in how they build the request.
 *
 * @typedef {object} GenerationRequest
 * @property {string} [model] Falls back to config.lockedModel.
 * @property {string} [provider] Must agree with the model's configured provider when given.
 * @property {string} template
 * @property {Record<string, string>} vars
 * @property {string[]} [characters]
 * @property {string[]} refPaths Reference images in order; for an edit the first one is the image being edited.
 * @property {string} [size] Defaults to 1024x1024 for openai and 1K for gemini.
 * @property {string} [aspect]
 * @property {number} n
 * @property {string} outDir Must resolve inside raw/ or out/.
 * @property {string} stage
 * @property {string} [quality]
 * @property {string} [background]
 * @property {boolean} dryRun
 * @property {boolean} yes
 * @property {boolean} allowStub
 * @property {boolean} allowUnlocked Permits a --model other than config.lockedModel.
 * @property {boolean} balance
 *
 * @typedef {object} RunDeps
 * @property {string} rootDir assets-src/branding
 * @property {ReturnType<typeof import('./config.mjs').parseConfig>} config
 * @property {ReturnType<typeof import('./prompt-kit.mjs').loadPromptKit>} kit
 * @property {Record<'openai' | 'gemini', { apiKey?: string, baseUrl: string }>} env
 * @property {typeof fetch} fetchImpl
 * @property {(line: string) => void} print
 * @property {(question: string) => Promise<boolean>} confirm
 * @property {() => Date} now
 * @property {number} [retryDelayMs] Wait before the one retry of a relay upstream_error.
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/** @param {string} rootDir @param {string} outDir */
export function resolveOutDir(rootDir, outDir) {
    // resolve() also normalises an absolute path, so "<root>/out/../../x" is checked as the place it points to.
    const absolute = resolve(rootDir, outDir);
    const allowed = ['raw', 'out'].map((name) => resolve(rootDir, name));
    const inside = allowed.some((base) => absolute === base || absolute.startsWith(base + sep));
    if (!inside) {
        throw new Error(`--out must be inside raw/ or out/ (both git-ignored); got ${outDir}.`);
    }
    return absolute;
}

export function resolveModel(config, request) {
    const model = request.model ?? config.lockedModel;
    if (!model) {
        throw new Error('No model: pass --model, or set lockedModel in config.json after the bake-off.');
    }
    const priced = config.models[model];
    if (!priced) {
        throw new Error(`Model "${model}" is not in config.json. Known: ${Object.keys(config.models).join(', ')}.`);
    }
    if (request.provider && request.provider !== priced.provider) {
        throw new Error(`Model "${model}" belongs to provider "${priced.provider}", not "${request.provider}".`);
    }
    const strays = Boolean(request.model && config.lockedModel && request.model !== config.lockedModel);
    if (strays && !request.allowUnlocked) {
        throw new Error(`Model "${model}" is not the locked model (${config.lockedModel}). Pass --allow-unlocked to use it anyway.`);
    }
    const warning = strays ? `WARNING: ${model} is not the locked model (${config.lockedModel}); --allow-unlocked was passed.` : undefined;
    return { model, provider: priced.provider, warning };
}

/**
 * @param {GenerationRequest} request
 * @param {RunDeps} deps
 */
export async function runGeneration(request, deps) {
    const { rootDir, config, kit, env, fetchImpl, confirm, now } = deps;
    const knownSecrets = Object.values(env).map((settings) => settings.apiKey);
    const say = (line) => deps.print(redactText(line, knownSecrets));

    const { model, provider: providerName, warning } = resolveModel(config, request);
    const outDir = resolveOutDir(rootDir, request.outDir);
    const refs = request.refPaths.map((path) => readReference(path));
    const composed = composePrompt(kit, request.template, { vars: request.vars, characters: request.characters, refCount: refs.length });

    const size = request.size ?? DEFAULT_SIZES[providerName];
    const background = resolveBackground({ requested: request.background, provider: providerName, promptBackground: composed.resolvedVars.background });
    const job = {
        model,
        prompt: composed.prompt,
        refs,
        size,
        n: request.n,
        aspect: request.aspect,
        quality: request.quality,
        background,
    };
    const provider = createProvider(providerName, {
        apiKey: env[providerName].apiKey ?? '',
        baseUrl: env[providerName].baseUrl,
        fetchImpl,
        retryDelayMs: deps.retryDelayMs,
        sleep: deps.sleep,
        onRetry: (message) => say(`retry: ${message}`),
    });
    provider.validate(job);

    const batch = estimateBatch(config, { model, n: request.n, size, promptChars: composed.prompt.length, refCount: refs.length });
    const logPath = join(rootDir, 'log', 'generations.jsonl');
    const runningUsd = runningTotalUsd(readLog(logPath));
    const refHashes = refs.map((ref) => sha256(ref.bytes));

    if (warning) {
        say(warning);
    }
    say(`${providerName} / ${model}   template: ${request.template}   stage: ${request.stage}`);
    say(`size: ${size}${request.aspect ? ` (${request.aspect})` : ''}   requests: ${request.n} (one image each)   references: ${refs.length}`);
    say(`estimate: ${request.n} x ${usd(batch.perImageUsd)} = ${usd(batch.totalUsd)}${batch.isEstimate ? ' (ESTIMATE: token-billed)' : ''}`);
    say(`logged so far: ${usd(runningUsd)}   cap: ${usd(config.costCapUsd)}`);

    if (request.dryRun) {
        return printDryRun({ say, composed, refs, refHashes, request, provider, job, batch, runningUsd, config });
    }

    if (composed.status === 'stub' && !request.allowStub) {
        throw new Error(`Template "${request.template}" is a stub. Finish it, or pass --allow-stub to spend money on it anyway.`);
    }
    requireKey(env[providerName], providerName);
    assertWithinCap(config, { runningUsd, batchUsd: batch.totalUsd });
    const approved = request.yes || await confirm(`Send ${request.n} image${request.n > 1 ? 's' : ''} for ${usd(batch.totalUsd)} to ${new URL(env[providerName].baseUrl).host}?`);
    if (!approved) {
        throw new Error('Cancelled. Nothing was sent.');
    }

    const tokenRun = startRun({ rootDir, provider: providerName, now });
    try {
        const balanceBefore = request.balance ? await tryBalance({ say, env, providerName, config, fetchImpl }) : undefined;
        const result = await provider.generate(job);
        if (result.images.length === 0) {
            throw new Error(`No images were made: ${result.error ?? 'unknown failure'}`);
        }

        const stamp = now().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        const stem = `${stamp}-${model}-${request.template}`;
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${stem}.prompt.txt`), `${composed.prompt}\n`, { flag: 'wx' });
        const outputs = result.images.map((image, index) => {
            const { ext } = sniffImage(image.bytes);
            const path = join(outDir, `${stem}-${index + 1}.${ext}`);
            writeFileSync(path, image.bytes, { flag: 'wx' });
            return { file: relative(rootDir, path).split(sep).join('/'), sha256: sha256(image.bytes) };
        });

        const spentUsd = Math.round(batch.perImageUsd * outputs.length * 1e6) / 1e6;
        for (const output of outputs) {
            say(`saved ${output.file}`);
        }
        if (background === 'transparent') {
            for (const [index, image] of result.images.entries()) {
                if (!pngHasAlpha(image.bytes)) {
                    say(`WARNING: ${outputs[index].file} has no transparency although a transparent background was requested. Key it out with key-bg.mjs, or retry with --vars background="flat pure green #00FF00" --background opaque.`);
                }
            }
        }
        for (const usage of result.usage) {
            say(`usage: ${JSON.stringify(usage)}`);
        }
        const chargedUsd = balanceBefore ? await measureCharge({ say, env, providerName, config, fetchImpl, balanceBefore, spentUsd, tokenRun, now }) : undefined;
        const entry = makeLogEntry({
            time: now().toISOString(),
            stage: request.stage,
            provider: providerName,
            model,
            template: request.template,
            vars: { ...composed.resolvedVars, characters: composed.characters.join(',') },
            refHashes,
            size: request.aspect ? `${size}/${request.aspect}` : size,
            outputs,
            estimatedUsd: spentUsd,
            chargedUsd,
        });
        appendLogEntry(logPath, entry);
        if (result.error) {
            say(`STOPPED EARLY after ${outputs.length} of ${request.n}: ${result.error}`);
        }
        return { dryRun: false, entry, partial: Boolean(result.error) };
    } finally {
        endRun(tokenRun, { now });
    }
}

function printDryRun({ say, composed, refs, refHashes, request, provider, job, batch, runningUsd, config }) {
    const projected = Math.round((runningUsd + batch.totalUsd) * 1e6) / 1e6;
    say(projected > config.costCapUsd ? `WOULD REFUSE: ${usd(projected)} passes the cap.` : `within cap: ${usd(projected)} after this batch.`);
    if (composed.status === 'stub') {
        say(`WOULD REFUSE: template "${request.template}" is a stub (needs --allow-stub).`);
    }
    say('--- prompt ---');
    say(composed.prompt);
    say('--- references ---');
    if (refs.length === 0) {
        say('(none)');
    }
    refs.forEach((ref, index) => say(`${index + 1}. ${ref.filename}  ${ref.mime}  ${ref.bytes.length} bytes  sha256 ${refHashes[index].slice(0, 16)}`));
    say('--- request (credentials redacted, image bytes elided) ---');
    say(JSON.stringify(describePlan(provider.plan(job)), null, 2));
    say('dry run: nothing was sent, saved or logged.');
    return { dryRun: true, prompt: composed.prompt, batch };
}

export async function tryBalance({ say, env, providerName, config, fetchImpl }) {
    try {
        const balance = await readBalance({ apiKey: env[providerName].apiKey, baseUrl: env[providerName].baseUrl, unitsPerUsd: config.pricing.unitsPerUsd, fetchImpl });
        const account = balance.availableUsd === undefined ? '' : `${usd(balance.availableUsd)} available, `;
        say(`balance: ${account}${balance.totalUsedUnits} units used on this token`);
        return balance;
    } catch (error) {
        say(`balance unavailable: ${error.message}`);
        return undefined;
    }
}

/**
 * The relay's charge for this run: the change in the token's total_used. It is only right when nothing else
 * spends from the same token during the run, so it is dropped, with a warning, when the run records show an overlap.
 * Returns undefined when the balance cannot be read or the figure cannot be trusted.
 */
export async function measureCharge({ say, env, providerName, config, fetchImpl, balanceBefore, spentUsd, tokenRun, now }) {
    const after = await tryBalance({ say, env, providerName, config, fetchImpl });
    const units = after ? after.totalUsedUnits - balanceBefore.totalUsedUnits : undefined;
    if (units === undefined || units < 0) {
        return undefined;
    }
    if (warnIfOverlapped({ say, tokenRun, now, spentUsd })) {
        return undefined;
    }
    const chargedUsd = Math.round((units / config.pricing.unitsPerUsd) * 1e6) / 1e6;
    say(`relay charged ${usd(chargedUsd)} (${units} units); estimate was ${usd(spentUsd)}`);
    return chargedUsd;
}

/** Prints the reason a measured charge is not recorded, and says whether it printed. */
export function warnIfOverlapped({ say, tokenRun, now, spentUsd }) {
    const others = otherRunsDuring(tokenRun, { now });
    if (others.length === 0) {
        return false;
    }
    const who = others.map((other) => `pid ${other.pid}, started ${new Date(other.startedAt).toISOString().slice(11, 19)} UTC`).join('; ');
    say(`WARNING: chargedUsd not recorded: another run used this token at the same time (${who}), so the balance change counts both runs. The estimate of ${usd(spentUsd)} stands.`);
    return true;
}
