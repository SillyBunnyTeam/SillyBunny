import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { loadEnvironment } from './env.mjs';
import { loadPromptKit } from './prompt-kit.mjs';
import { redactText } from './redact.mjs';
import { runPatches } from './patch-run.mjs';
import { runGeneration } from './run.mjs';

export const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SHARED_OPTIONS = {
    provider: { type: 'string' },
    model: { type: 'string' },
    refs: { type: 'string' },
    characters: { type: 'string' },
    size: { type: 'string' },
    aspect: { type: 'string' },
    n: { type: 'string', default: '1' },
    out: { type: 'string' },
    stage: { type: 'string' },
    quality: { type: 'string' },
    background: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    'allow-stub': { type: 'boolean', default: false },
    'allow-unlocked': { type: 'boolean', default: false },
    balance: { type: 'boolean', default: false },
};

const MODE_OPTIONS = {
    generate: { ...SHARED_OPTIONS, template: { type: 'string' }, vars: { type: 'string', multiple: true } },
    edit: { ...SHARED_OPTIONS, image: { type: 'string' }, instruction: { type: 'string' } },
};

const splitList = (value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined);

/** Input files are looked up from the working directory first, then from assets-src/branding. */
function resolveInput(rootDir, path) {
    if (isAbsolute(path) || existsSync(path)) {
        return resolve(path);
    }
    return resolve(rootDir, path);
}

function parseVars(pairs = []) {
    return Object.fromEntries(pairs.map((pair) => {
        const at = pair.indexOf('=');
        if (at < 1) {
            throw new Error(`--vars expects name=value, got "${pair}".`);
        }
        return [pair.slice(0, at), pair.slice(at + 1)];
    }));
}

/**
 * Turns argv into a trusted GenerationRequest. Anything wrong fails here, before a file is read or a cent is spent.
 * @param {'generate' | 'edit'} mode
 * @param {string[]} argv
 * @param {string} rootDir
 * @returns {import('./run.mjs').GenerationRequest}
 */
export function parseRequest(mode, argv, rootDir = ROOT_DIR) {
    const { values } = parseArgs({ args: argv, options: MODE_OPTIONS[mode], strict: true, allowPositionals: false });
    const n = Number(values.n);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error('--n must be a whole number of 1 or more.');
    }
    const stage = values.stage ?? (values.out ? values.out.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : undefined);
    if (!stage || !(values.out ?? values.stage)) {
        throw new Error('Pass --out raw/<stage>/ (or --stage <stage>).');
    }
    const shared = {
        provider: values.provider,
        model: values.model,
        characters: splitList(values.characters),
        size: values.size,
        aspect: values.aspect,
        n,
        outDir: values.out ?? join('raw', stage),
        stage,
        quality: values.quality,
        background: values.background,
        dryRun: values['dry-run'],
        yes: values.yes,
        allowStub: values['allow-stub'],
        allowUnlocked: values['allow-unlocked'],
        balance: values.balance,
    };
    const extraRefs = (splitList(values.refs) ?? []).map((path) => resolveInput(rootDir, path));

    if (mode === 'generate') {
        if (!values.template) {
            throw new Error('Pass --template <name>.');
        }
        return { ...shared, template: values.template, vars: parseVars(values.vars), refPaths: extraRefs };
    }
    if (!values.image || !values.instruction) {
        throw new Error('Pass --image <file> and --instruction "<what to change>".');
    }
    return {
        ...shared,
        template: 'edit',
        vars: { instruction: values.instruction },
        refPaths: [resolveInput(rootDir, values.image), ...extraRefs],
    };
}

export async function askYesNo(question) {
    if (!process.stdin.isTTY) {
        throw new Error('Confirmation needs a terminal. Pass --yes for scripted runs.');
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
        rl.close();
    }
}

const PATCH_OPTIONS = {
    image: { type: 'string' },
    spec: { type: 'string' },
    instruction: { type: 'string' },
    model: { type: 'string' },
    n: { type: 'string' },
    feather: { type: 'string', default: '6' },
    reuse: { type: 'string' },
    'keep-alpha': { type: 'boolean', default: false },
    out: { type: 'string' },
    stage: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    balance: { type: 'boolean', default: false },
    'allow-unlocked': { type: 'boolean', default: false },
};

// Flags that steer the model call, which --reuse never makes.
const MODEL_CALL_FLAGS = ['n', 'model', 'instruction', 'balance', 'allow-unlocked'];

/**
 * Turns patch.mjs argv into a trusted request: the spec file is read here, so a bad path or bad JSON fails before any cost.
 * @param {string[]} argv
 * @param {string} rootDir
 * @returns {import('./patch-run.mjs').PatchRequest}
 */
export function parsePatchRequest(argv, rootDir = ROOT_DIR) {
    const { values } = parseArgs({ args: argv, options: PATCH_OPTIONS, strict: true, allowPositionals: false });
    for (const [flag, value] of [['--image', values.image], ['--spec', values.spec], ['--out', values.out ?? values.stage]]) {
        if (!value) {
            throw new Error(`Pass ${flag} (see the usage in the README).`);
        }
    }
    const ignoredFlag = values.reuse ? MODEL_CALL_FLAGS.find((flag) => values[flag]) : undefined;
    if (ignoredFlag) {
        throw new Error(`--reuse makes no model call, so --${ignoredFlag} has no effect. The variants come from the reused run.`);
    }
    const n = Number(values.n ?? '1');
    const feather = Number(values.feather);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error('--n must be a whole number of 1 or more.');
    }
    if (!Number.isInteger(feather) || feather < 0) {
        throw new Error('--feather must be a whole number of 0 or more.');
    }
    const specPath = resolveInput(rootDir, values.spec);
    let patches;
    try {
        patches = JSON.parse(readFileSync(specPath, 'utf8'));
    } catch (error) {
        throw new Error(error instanceof SyntaxError ? `${values.spec} is not valid JSON: ${error.message}` : `Cannot read ${values.spec}: ${error.message}`);
    }
    const stage = values.stage ?? values.out.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return {
        imagePath: resolveInput(rootDir, values.image),
        patches,
        instruction: values.instruction,
        model: values.model,
        n,
        feather,
        reuse: values.reuse,
        keepAlpha: values['keep-alpha'],
        outDir: values.out ?? join('raw', stage),
        stage,
        dryRun: values['dry-run'],
        yes: values.yes,
        balance: values.balance,
        allowUnlocked: values['allow-unlocked'],
    };
}

export function runDeps(env) {
    return {
        rootDir: ROOT_DIR,
        config: loadConfig(join(ROOT_DIR, 'config.json')),
        kit: loadPromptKit(join(ROOT_DIR, 'prompts')),
        env,
        fetchImpl: fetch,
        print: (line) => process.stdout.write(`${line}\n`),
        confirm: askYesNo,
        now: () => new Date(),
    };
}

/** Entry point for patch.mjs. */
export async function patchMain(argv = process.argv.slice(2)) {
    const env = loadEnvironment({ dotenvPath: join(ROOT_DIR, '.env') });
    const secrets = Object.values(env).map((settings) => settings.apiKey);
    try {
        const outcome = await runPatches(parsePatchRequest(argv), runDeps(env));
        process.exitCode = outcome.partial ? 1 : 0;
    } catch (error) {
        process.stderr.write(`error: ${redactText(error.message, secrets)}\n`);
        process.exitCode = 1;
    }
}

/** Entry point shared by generate.mjs and edit.mjs. Sets the exit code and never prints a stack trace with a secret. */
export async function main(mode, argv = process.argv.slice(2)) {
    const env = loadEnvironment({ dotenvPath: join(ROOT_DIR, '.env') });
    const secrets = Object.values(env).map((settings) => settings.apiKey);
    try {
        const request = parseRequest(mode, argv);
        const outcome = await runGeneration(request, runDeps(env));
        process.exitCode = outcome.partial ? 1 : 0;
    } catch (error) {
        process.stderr.write(`error: ${redactText(error.message, secrets)}\n`);
        process.exitCode = 1;
    }
}
