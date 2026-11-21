import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SENT_TEXT_FIELDS } from '../scripts/lib/masters.mjs';
import { composePrompt, loadPromptKit } from '../scripts/lib/prompt-kit.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const REAL_PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

function writeKit(files) {
    const dir = tempDir('sb-kit-');
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), text);
    }
    return dir;
}

const MINI_KIT = {
    'style-illustrated.md': 'STYLE TEXT',
    'character-a.md': 'A DESCRIPTORS',
    'character-b.md': 'B DESCRIPTORS',
    'constraints.md': '## sfw\nSFW TEXT\n\n## references\nREFS TEXT\n',
    'templates/sheet.md': [
        '---',
        'status: ready',
        'style: illustrated',
        'characters: a',
        'constraints: sfw, references',
        'require: pose',
        'var.name:',
        'var.mood: calm',
        '---',
        'Pose is {pose}, mood {mood}.',
        'Name: {name}',
    ].join('\n'),
};

test('composes style, characters, template, then constraints in that order', () => {
    const kit = loadPromptKit(writeKit(MINI_KIT));
    const { prompt } = composePrompt(kit, 'sheet', { vars: { pose: 'standing' }, refCount: 0 });
    const order = ['STYLE TEXT', 'A DESCRIPTORS', 'Pose is standing, mood calm.', 'SFW TEXT'];
    const positions = order.map((part) => prompt.indexOf(part));
    assert.ok(positions.every((p) => p >= 0), prompt);
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('drops the line of an optional placeholder that stays empty, and keeps it once set', () => {
    const kit = loadPromptKit(writeKit(MINI_KIT));
    const empty = composePrompt(kit, 'sheet', { vars: { pose: 'standing' }, refCount: 0 });
    assert.ok(!empty.prompt.includes('Name:'));
    const named = composePrompt(kit, 'sheet', { vars: { pose: 'standing', name: 'Alice' }, refCount: 0 });
    assert.match(named.prompt, /Name: Alice/);
    assert.equal(named.resolvedVars.name, 'Alice');
});

test('includes the references section only when references are attached', () => {
    const kit = loadPromptKit(writeKit(MINI_KIT));
    assert.ok(!composePrompt(kit, 'sheet', { vars: { pose: 'x' }, refCount: 0 }).prompt.includes('REFS TEXT'));
    assert.ok(composePrompt(kit, 'sheet', { vars: { pose: 'x' }, refCount: 2 }).prompt.includes('REFS TEXT'));
});

test('labels several characters and lets the caller override the default list', () => {
    const kit = loadPromptKit(writeKit(MINI_KIT));
    const { prompt, characters } = composePrompt(kit, 'sheet', { vars: { pose: 'x' }, characters: ['a', 'b'], refCount: 0 });
    assert.deepEqual(characters, ['a', 'b']);
    assert.match(prompt, /Character 1[^]*A DESCRIPTORS[^]*Character 2[^]*B DESCRIPTORS/);
});

test('fails loudly on a missing required variable, an unknown variable and an unknown template', () => {
    const kit = loadPromptKit(writeKit(MINI_KIT));
    assert.throws(() => composePrompt(kit, 'sheet', { vars: {}, refCount: 0 }), /pose/);
    assert.throws(() => composePrompt(kit, 'sheet', { vars: { pose: 'x', typo: 'y' }, refCount: 0 }), /typo/);
    assert.throws(() => composePrompt(kit, 'nope', { vars: {}, refCount: 0 }), /nope/);
    assert.throws(() => composePrompt(kit, 'sheet', { vars: { pose: 'x' }, characters: ['zzz'], refCount: 0 }), /zzz/);
});

test('rejects a template whose placeholder is not declared', () => {
    const bad = { ...MINI_KIT, 'templates/bad.md': '---\nstatus: ready\nstyle: none\ncharacters: none\nconstraints: sfw\n---\nHello {who}' };
    assert.throws(() => loadPromptKit(writeKit(bad)), /who/);
});

test('rejects a template that names a missing style or constraint section', () => {
    const noStyle = { ...MINI_KIT, 'templates/bad.md': '---\nstatus: ready\nstyle: pixel\ncharacters: none\nconstraints: sfw\n---\nHi' };
    assert.throws(() => loadPromptKit(writeKit(noStyle)), /pixel/);
    const noSection = { ...MINI_KIT, 'templates/bad.md': '---\nstatus: ready\nstyle: none\ncharacters: none\nconstraints: nope\n---\nHi' };
    assert.throws(() => loadPromptKit(writeKit(noSection)), /nope/);
});

test('reports stub templates so a real run can refuse them', () => {
    const stub = { ...MINI_KIT, 'templates/stub.md': '---\nstatus: stub\nstyle: none\ncharacters: none\nconstraints: sfw\n---\nHi' };
    const kit = loadPromptKit(writeKit(stub));
    assert.equal(composePrompt(kit, 'stub', { vars: {}, refCount: 0 }).status, 'stub');
});

const REQUIRED_TEMPLATES = [
    'design-sheet-illustrated', 'design-sheet-pixel', 'lineup', 'logo-concept', 'pixel-still', 'pixel-edit-blink',
    'pixel-edit-ear', 'pixel-edit-mouth', 'card-portrait', 'expression-pose-base', 'expression-face-edit',
    'github-banner', 'social-preview', 'org-avatar', 'edit',
];

test('the shipped kit loads and has every template the art plan lists', () => {
    const kit = loadPromptKit(REAL_PROMPTS);
    for (const id of REQUIRED_TEMPLATES) {
        assert.ok(kit.templates.has(id), `missing template ${id}`);
    }
});

test('the three stage-ready templates compose without character names by default', () => {
    const kit = loadPromptKit(REAL_PROMPTS);
    const sheet = composePrompt(kit, 'design-sheet-illustrated', { vars: {}, refCount: 0 });
    const lineup = composePrompt(kit, 'lineup', { vars: {}, refCount: 2 });
    const card = composePrompt(kit, 'card-portrait', { vars: { pose: 'waving' }, refCount: 1 });
    for (const { prompt, status } of [sheet, lineup, card]) {
        assert.equal(status, 'ready');
        assert.ok(!/\{[a-z_]+\}/.test(prompt), 'unresolved placeholder left in prompt');
    }
    assert.match(lineup.prompt, /Character 1[^]*Character 2/);
});

test('a stage can set the name variable and it reaches the prompt', () => {
    const kit = loadPromptKit(REAL_PROMPTS);
    const { prompt } = composePrompt(kit, 'design-sheet-illustrated', { vars: { name: 'Example Name' }, refCount: 0 });
    assert.match(prompt, /Name: Example Name/);
});

const sentSpecText = (file) => Object.values(JSON.parse(readFileSync(file, 'utf8')).assets)
    .flatMap((asset) => SENT_TEXT_FIELDS.map((field) => asset[field] ?? ''))
    .join('\n');

test('no prompt file names an artist, studio, game, franchise or character', () => {
    const banned = /touhou|imperishable|\bzun\b|team shanghai|reisen|tewi|inaba|udongein|hero of ice fairy|in the style of|style of|silly ?tavern/i;
    const files = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            entry.isDirectory() ? walk(path) : files.push(path);
        }
    };
    walk(REAL_PROMPTS);
    assert.ok(files.length >= 20);
    assert.ok(files.some((file) => file.endsWith('s5-masters.json')), 'the masters spec is checked too');
    for (const file of files) {
        // Front matter holds file ids such as "characters: reisen" and a spec holds refs and ids; only the text that is sent matters.
        const sentText = file.endsWith('.json') ? sentSpecText(file) : readFileSync(file, 'utf8').replace(/^---\n[^]*?\n---\n/, '');
        assert.ok(!banned.test(sentText), `${file} contains a banned name`);
    }
    // Tewi is a very old youkai in a petite body, so her descriptors must not read as a child.
    const tewi = readFileSync(join(REAL_PROMPTS, 'character-tewi.md'), 'utf8');
    for (const word of ['child', 'childlike', 'little girl', 'youthful-looking']) {
        assert.ok(!tewi.toLowerCase().includes(word), `character-tewi.md contains "${word}"`);
    }
});
