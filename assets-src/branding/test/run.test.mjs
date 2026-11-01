import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseRequest } from '../scripts/lib/cli.mjs';
import { loadConfig } from '../scripts/lib/config.mjs';
import { loadEnvironment } from '../scripts/lib/env.mjs';
import { sha256 } from '../scripts/lib/log.mjs';
import { loadPromptKit } from '../scripts/lib/prompt-kit.mjs';
import { runGeneration } from '../scripts/lib/run.mjs';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'sk-test-0123456789abcdefABCDEF';
const GEMINI_KEY = 'AIzaSyFAKE0123456789abcdefghijklmnopq';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const config = loadConfig(join(BRANDING, 'config.json'));
const kit = loadPromptKit(join(BRANDING, 'prompts'));

function makeRoot(logLines = []) {
    const root = mkdtempSync(join(tmpdir(), 'sb-run-'));
    mkdirSync(join(root, 'log'));
    writeFileSync(join(root, 'log', 'generations.jsonl'), logLines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    writeFileSync(join(root, 'ref.png'), PNG);
    return root;
}

function makeDeps(root, { replies, answer = true, env } = {}) {
    const lines = [];
    const calls = [];
    const queue = [...(replies ?? [])];
    return {
        lines,
        calls,
        deps: {
            rootDir: root,
            config,
            kit,
            env: env ?? loadEnvironment({ env: { OPENAI_API_KEY: KEY, GEMINI_API_KEY: GEMINI_KEY } }),
            fetchImpl: async (url, init) => {
                calls.push({ url: String(url), init });
                const reply = queue.length > 1 ? queue.shift() : queue[0];
                if (!reply) {
                    throw new Error('unexpected network call');
                }
                return new Response(reply.json ? JSON.stringify(reply.json) : reply.text, { status: reply.status ?? 200 });
            },
            print: (line) => lines.push(line),
            confirm: async () => answer,
            now: () => new Date('2026-11-01T12:00:00.000Z'),
        },
    };
}

const baseRequest = (root, overrides = {}) => ({
    model: 'gpt-image-2.5-sunburst-h',
    template: 'design-sheet-illustrated',
    vars: {},
    refPaths: [],
    n: 2,
    outDir: 'raw/s1',
    stage: 's1',
    dryRun: false,
    yes: true,
    allowStub: false,
    allowUnlocked: false,
    balance: false,
    ...overrides,
});

const openaiReply = () => ({ json: { data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 25, output_tokens: 1055 } } });

test('a real run works on a checkout with no log/ yet and creates the log', async () => {
    const root = makeRoot();
    rmSync(join(root, 'log'), { recursive: true });
    const { deps } = makeDeps(root, { replies: [openaiReply()] });
    await runGeneration(baseRequest(root, { n: 1 }), deps);
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim().split('\n').length, 1);
    const dry = makeDeps(root);
    rmSync(join(root, 'log'), { recursive: true });
    await runGeneration(baseRequest(root, { dryRun: true }), dry.deps);
    assert.ok(!existsSync(join(root, 'log')), 'a dry run still writes nothing');
});

test('a dry run prints prompt, references and estimate, needs no key, and touches nothing', async () => {
    const root = makeRoot();
    const { deps, lines, calls } = makeDeps(root, { env: loadEnvironment({ env: {} }) });
    const outcome = await runGeneration(baseRequest(root, { dryRun: true, refPaths: [join(root, 'ref.png')], n: 4 }), deps);
    const output = lines.join('\n');
    assert.equal(outcome.dryRun, true);
    assert.equal(calls.length, 0);
    assert.match(output, /estimate: 4 x \$0\.20 = \$0\.80/);
    assert.match(output, /cap: \$10\.00/);
    assert.match(output, /Character design sheet/);
    assert.match(output, new RegExp(`sha256 ${sha256(PNG).slice(0, 16)}`));
    assert.match(output, /\/images\/edits/);
    assert.match(output, /nothing was sent, saved or logged/);
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8'), '');
    assert.ok(!existsSync(join(root, 'raw')));
});

test('a real run saves outputs, appends a log line in the documented shape and prints no key', async () => {
    const root = makeRoot();
    const { deps, lines, calls } = makeDeps(root, { replies: [openaiReply()] });
    await runGeneration(baseRequest(root, { refPaths: [join(root, 'ref.png')] }), deps);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.init.body.get('n')), ['1', '1']);
    const files = readdirSync(join(root, 'raw', 's1'));
    assert.equal(files.filter((f) => f.endsWith('.png')).length, 2);
    assert.equal(files.filter((f) => f.endsWith('.prompt.txt')).length, 1);

    const rawLog = readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8');
    const entry = JSON.parse(rawLog.trim());
    assert.deepEqual(Object.keys(entry), ['time', 'stage', 'provider', 'model', 'template', 'vars', 'refs', 'size', 'n', 'outputs', 'estimatedUsd', 'approved']);
    assert.equal(entry.time, '2026-11-01T12:00:00.000Z');
    assert.equal(entry.provider, 'openai');
    assert.equal(entry.size, '1024x1024');
    assert.equal(entry.n, 2);
    assert.equal(entry.estimatedUsd, 0.4);
    assert.equal(entry.approved, false);
    assert.deepEqual(entry.refs, [sha256(PNG)]);
    assert.equal(entry.outputs[0].sha256, sha256(PNG));
    assert.match(entry.outputs[0].file, /^raw\/s1\/20261101T120000Z-gpt-image-2\.5-sunburst-h-design-sheet-illustrated-1\.png$/);
    assert.equal(entry.vars.characters, 'reisen');

    for (const text of [rawLog, lines.join('\n')]) {
        assert.ok(!text.includes(KEY));
        assert.ok(!text.includes(GEMINI_KEY));
    }
});

test('the cap refuses before anything is sent', async () => {
    const root = makeRoot([{ estimatedUsd: 9.7 }]);
    const { deps, calls } = makeDeps(root, { replies: [openaiReply()] });
    await assert.rejects(runGeneration(baseRequest(root), deps), /costCapUsd/);
    assert.equal(calls.length, 0);
});

test('declining the confirmation sends nothing, and --yes skips the question', async () => {
    const root = makeRoot();
    const declined = makeDeps(root, { replies: [openaiReply()], answer: false });
    await assert.rejects(runGeneration(baseRequest(root, { yes: false }), declined.deps), /Nothing was sent/);
    assert.equal(declined.calls.length, 0);

    const asked = [];
    const scripted = makeDeps(root, { replies: [openaiReply()], answer: false });
    scripted.deps.confirm = async (question) => (asked.push(question), false);
    await runGeneration(baseRequest(root, { yes: true }), scripted.deps);
    assert.equal(asked.length, 0);
    assert.equal(scripted.calls.length, 2);
});

test('the confirmation question shows the price', async () => {
    const root = makeRoot();
    const asked = [];
    const { deps } = makeDeps(root, { replies: [openaiReply()] });
    deps.confirm = async (question) => (asked.push(question), true);
    await runGeneration(baseRequest(root, { yes: false }), deps);
    assert.match(asked[0], /\$0\.40/);
});

test('a missing key is named, never echoed', async () => {
    const root = makeRoot();
    const { deps } = makeDeps(root, { env: loadEnvironment({ env: {} }) });
    await assert.rejects(runGeneration(baseRequest(root), deps), /OPENAI_API_KEY is not set/);
});

test('a stub template is refused for real runs unless --allow-stub is passed', async () => {
    const root = makeRoot();
    const { deps, calls } = makeDeps(root, { replies: [openaiReply()] });
    const stub = baseRequest(root, { template: 'logo-concept' });
    await assert.rejects(runGeneration(stub, deps), /stub/);
    assert.equal(calls.length, 0);
    await runGeneration({ ...stub, allowStub: true }, deps);
    assert.equal(calls.length, 2);
});

test('the shipped config locks Sunburst and generate and edit use it when --model is absent', async () => {
    assert.equal(config.lockedModel, 'gpt-image-2.5-sunburst-h');
    const root = makeRoot();
    const { deps, lines } = makeDeps(root);
    await runGeneration(baseRequest(root, { model: undefined, dryRun: true }), deps);
    assert.match(lines.join('\n'), /openai \/ gpt-image-2\.5-sunburst-h/);
});

test('with no locked model and no --model the run stops', async () => {
    const root = makeRoot();
    const { deps } = makeDeps(root);
    deps.config = { ...config, lockedModel: null };
    await assert.rejects(runGeneration(baseRequest(root, { model: undefined, dryRun: true }), deps), /lockedModel/);
    deps.config = { ...config, lockedModel: null };
    await runGeneration(baseRequest(root, { model: 'gemini-nano-banana-2.1', size: '2K', dryRun: true }), deps);
});

test('a different explicit model needs --allow-unlocked and then prints a warning; the locked model never does', async () => {
    const root = makeRoot();
    const { deps, lines, calls } = makeDeps(root, { replies: [openaiReply()] });
    await assert.rejects(runGeneration(baseRequest(root, { model: 'gemini-nano-banana-2.1', size: '2K', dryRun: true }), deps), /--allow-unlocked/);
    assert.equal(calls.length, 0);

    await runGeneration(baseRequest(root, { model: 'gemini-nano-banana-2.1', size: '2K', dryRun: true, allowUnlocked: true }), deps);
    assert.match(lines.join('\n'), /WARNING: gemini-nano-banana-2\.1 is not the locked model \(gpt-image-2\.5-sunburst-h\)/);

    lines.length = 0;
    await runGeneration(baseRequest(root, { model: 'gpt-image-2.5-sunburst-h', dryRun: true }), deps);
    assert.ok(!lines.join('\n').includes('WARNING'));
    await runGeneration(baseRequest(root, { model: undefined, dryRun: true, allowUnlocked: true }), deps);
    assert.ok(!lines.join('\n').includes('WARNING'));
});

test('the unlocked guard also stops a real run before anything is sent', async () => {
    const root = makeRoot();
    const { deps, calls } = makeDeps(root, { replies: [openaiReply()] });
    await assert.rejects(runGeneration(baseRequest(root, { model: 'gpt-image-2.5-flare-h' }), deps), /--allow-unlocked/);
    assert.equal(calls.length, 0);
});

test('parseRequest reads --allow-unlocked', () => {
    const request = parseRequest('generate', ['--template', 'x', '--out', 'raw/a', '--allow-unlocked'], makeRoot());
    assert.equal(request.allowUnlocked, true);
    assert.equal(parseRequest('generate', ['--template', 'x', '--out', 'raw/a'], makeRoot()).allowUnlocked, false);
});

test('a provider that disagrees with the model, or an output folder outside raw/, is rejected', async () => {
    const root = makeRoot();
    const { deps } = makeDeps(root);
    await assert.rejects(runGeneration(baseRequest(root, { provider: 'gemini', dryRun: true }), deps), /belongs to provider/);
    await assert.rejects(runGeneration(baseRequest(root, { outDir: 'approved', dryRun: true }), deps), /raw\/ or out\//);
    await assert.rejects(runGeneration(baseRequest(root, { outDir: 'raw/../approved', dryRun: true }), deps), /raw\/ or out\//);
});

test('an early stop logs and charges only the images that were made', async () => {
    const root = makeRoot();
    const ok = { json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] } };
    const { deps, lines } = makeDeps(root, { replies: [ok, { status: 500, text: `boom ${GEMINI_KEY}` }] });
    const outcome = await runGeneration(baseRequest(root, { model: 'gemini-3-pro-image-preview', size: '1K', n: 3, allowUnlocked: true }), deps);
    const entry = JSON.parse(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim());
    assert.equal(outcome.partial, true);
    assert.equal(entry.n, 1);
    assert.equal(entry.estimatedUsd, 0.35);
    assert.match(lines.join('\n'), /STOPPED EARLY after 1 of 3: HTTP 500/);
    assert.ok(!lines.join('\n').includes(GEMINI_KEY));
});

test('a run that makes no image fails and logs nothing', async () => {
    const root = makeRoot();
    const { deps } = makeDeps(root, { replies: [{ status: 401, text: `bad ${KEY}` }] });
    const error = await runGeneration(baseRequest(root), deps).catch((e) => e);
    assert.match(error.message, /401/);
    assert.ok(!error.message.includes(KEY));
    assert.equal(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8'), '');
});

test('--balance reports the balance in dollars and the charge for the run, without the key', async () => {
    const root = makeRoot();
    const balance = (used) => ({ json: { data: { total_used: used, user_quota: { total_available: 4_000_000 } } } });
    const { deps, lines, calls } = makeDeps(root, { replies: [balance(1_000_000), openaiReply(), openaiReply(), balance(1_200_000)] });
    await runGeneration(baseRequest(root, { balance: true }), deps);
    const output = lines.join('\n');
    assert.equal(calls[0].url, 'https://api.linkapi.ai/api/usage/token/');
    assert.match(output, /balance: \$8\.00 available/);
    assert.match(output, /relay charged \$0\.40 \(200000 units\); estimate was \$0\.40/);
    assert.ok(!output.includes(KEY));
});

test('--balance still reports the charge when the token has no account quota', async () => {
    const root = makeRoot();
    const usage = (used) => ({ json: { data: { total_used: used } } });
    const { deps, lines } = makeDeps(root, { replies: [usage(500_000), openaiReply(), openaiReply(), usage(700_000)] });
    await runGeneration(baseRequest(root, { balance: true }), deps);
    const output = lines.join('\n');
    assert.match(output, /balance: 500000 units used on this token/);
    assert.ok(!/available/.test(output));
    assert.match(output, /relay charged \$0\.40 \(200000 units\); estimate was \$0\.40/);
});

test('a retried upstream_error is printed without the key', async () => {
    const root = makeRoot();
    const upstream = { status: 400, json: { error: { type: 'upstream_error', message: `User location is not supported ${GEMINI_KEY}` } } };
    const ok = { json: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: PNG.toString('base64') } }] } }] } };
    const { deps, lines, calls } = makeDeps(root, { replies: [upstream, ok] });
    deps.retryDelayMs = 0;
    await runGeneration(baseRequest(root, { model: 'gemini-3-pro-image-preview', size: '1K', n: 1, allowUnlocked: true }), deps);
    assert.equal(calls.length, 2);
    assert.match(lines.join('\n'), /retry: relay upstream_error \(HTTP 400\); retrying once in 0 ms/);
    assert.ok(!lines.join('\n').includes(GEMINI_KEY));
});

test('--balance writes the relay charge into the log line as chargedUsd, right after estimatedUsd', async () => {
    const root = makeRoot();
    const usage = (used) => ({ json: { data: { total_used: used } } });
    const { deps } = makeDeps(root, { replies: [usage(1_000_000), openaiReply(), openaiReply(), usage(1_300_000)] });
    await runGeneration(baseRequest(root, { balance: true }), deps);
    const entry = JSON.parse(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim());
    assert.equal(entry.chargedUsd, 0.6);
    assert.equal(entry.estimatedUsd, 0.4);
    assert.deepEqual(Object.keys(entry), ['time', 'stage', 'provider', 'model', 'template', 'vars', 'refs', 'size', 'n', 'outputs', 'estimatedUsd', 'chargedUsd', 'approved']);
});

test('without --balance, or when the balance cannot be read, the log line has no chargedUsd', async () => {
    const plainRoot = makeRoot();
    await runGeneration(baseRequest(plainRoot), makeDeps(plainRoot, { replies: [openaiReply()] }).deps);
    const failingRoot = makeRoot();
    await runGeneration(baseRequest(failingRoot, { balance: true }), makeDeps(failingRoot, { replies: [{ status: 500, text: 'down' }, openaiReply()] }).deps);
    for (const root of [plainRoot, failingRoot]) {
        const entry = JSON.parse(readFileSync(join(root, 'log', 'generations.jsonl'), 'utf8').trim());
        assert.ok(!('chargedUsd' in entry));
    }
});

test('the cost cap counts the charged amount where the log has one, and the estimate otherwise', async () => {
    const root = makeRoot([{ estimatedUsd: 0.2, chargedUsd: 9.8 }]);
    const refused = makeDeps(root, { replies: [openaiReply()] });
    await assert.rejects(runGeneration(baseRequest(root), refused.deps), /costCapUsd/);
    assert.equal(refused.calls.length, 0);

    const lowCharge = makeRoot([{ estimatedUsd: 9.8, chargedUsd: 0.2 }]);
    const allowed = makeDeps(lowCharge, { replies: [openaiReply()] });
    await runGeneration(baseRequest(lowCharge), allowed.deps);
    assert.equal(allowed.calls.length, 2);
});

test('a balance failure is a warning, not a stop', async () => {
    const root = makeRoot();
    const { deps, lines } = makeDeps(root, { replies: [{ status: 500, text: 'nope' }, openaiReply()] });
    await runGeneration(baseRequest(root, { balance: true }), deps);
    assert.match(lines.join('\n'), /balance unavailable/);
    assert.match(lines.join('\n'), /saved raw\/s1/);
});

test('parseRequest builds an edit from one image, an instruction and optional references', () => {
    const request = parseRequest('edit', ['--image', 'ref.png', '--instruction', 'change only the expression to joy', '--refs', 'ref.png', '--model', 'gpt-image-2.5-flare-h', '--out', 'raw/s7/', '--dry-run'], makeRoot());
    assert.equal(request.template, 'edit');
    assert.deepEqual(request.vars, { instruction: 'change only the expression to joy' });
    assert.equal(request.refPaths.length, 2);
    assert.equal(request.stage, 's7');
    assert.equal(request.dryRun, true);
});

test('parseRequest reads repeatable --vars and fails on bad input', () => {
    const request = parseRequest('generate', ['--template', 'card-portrait', '--vars', 'pose=waving', '--vars', 'name=Example', '--characters', 'tewi', '--out', 'raw/s6'], makeRoot());
    assert.deepEqual(request.vars, { pose: 'waving', name: 'Example' });
    assert.deepEqual(request.characters, ['tewi']);
    assert.throws(() => parseRequest('generate', ['--template', 'x'], makeRoot()), /--out/);
    assert.throws(() => parseRequest('generate', ['--template', 'x', '--out', 'raw/a', '--vars', 'oops'], makeRoot()), /name=value/);
    assert.throws(() => parseRequest('generate', ['--template', 'x', '--out', 'raw/a', '--n', '0'], makeRoot()), /--n/);
    assert.throws(() => parseRequest('generate', ['--out', 'raw/a'], makeRoot()), /--template/);
    assert.throws(() => parseRequest('generate', ['--template', 'x', '--out', 'raw/a', '--key', 'k'], makeRoot()));
});

test('environment loading reads only the four known names and refuses a plain-http remote URL', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.env'), `OPENAI_API_KEY="${KEY}"\nSOMETHING_ELSE=secret\nGEMINI_BASE_URL=https://example.test\n`);
    const settings = loadEnvironment({ env: { GEMINI_API_KEY: GEMINI_KEY }, dotenvPath: join(root, '.env') });
    assert.equal(settings.openai.apiKey, KEY);
    assert.equal(settings.gemini.apiKey, GEMINI_KEY);
    assert.equal(settings.openai.baseUrl, 'https://api.linkapi.ai/v1');
    assert.equal(settings.gemini.baseUrl, 'https://example.test');
    assert.throws(() => loadEnvironment({ env: { OPENAI_BASE_URL: 'http://relay.example/v1' } }), /https/);
    assert.doesNotThrow(() => loadEnvironment({ env: { OPENAI_BASE_URL: 'http://localhost:8080/v1' } }));
});
