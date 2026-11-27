import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from '@jest/globals';
import {
    GOLDEN_FIXTURE_MARKERS,
    GOLDEN_PROMPTS_DIR,
    GOLDEN_SCENARIOS,
    UPDATE_GOLDEN_ENV_VAR,
    assertGoldenPrompt,
    buildUnifiedLineDiff,
    canonicalizeGoldenRequest,
    extractPromptText,
    findVolatileArtifacts,
    formatGoldenJson,
    getGoldenFixturePath,
    loadGoldenFixture,
    shouldUpdateGoldenPrompts,
} from './util/golden-prompts.js';

const tempDirs = [];

function createTempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-golden-prompts-unit-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

/**
 * Verifies that every marker appears in `text` strictly after the previous marker.
 * @param {string} text
 * @param {string[]} orderedMarkers
 */
function expectOrderedMarkers(text, orderedMarkers) {
    let cursor = -1;
    for (const marker of orderedMarkers) {
        const position = text.indexOf(marker);
        expect(position).toBeGreaterThan(-1);
        expect(position).toBeGreaterThan(cursor);
        cursor = position;
    }
}

describe('golden prompt helper utilities', () => {
    test('validates kebab-case scenario ids and rejects traversal', () => {
        expect(getGoldenFixturePath('chat-completion-openai-full', '/tmp/golden')).toBe(
            path.join('/tmp/golden', 'chat-completion-openai-full.json'),
        );
        for (const badId of ['', '../escape', 'a/b', 'UpperCase', 'has space', 'under_score']) {
            expect(() => getGoldenFixturePath(badId)).toThrow(/Invalid golden prompt case id/);
        }
    });

    test('enables golden regeneration only when explicitly requested', () => {
        expect(shouldUpdateGoldenPrompts({})).toBe(false);
        expect(shouldUpdateGoldenPrompts({ [UPDATE_GOLDEN_ENV_VAR]: '' })).toBe(false);
        expect(shouldUpdateGoldenPrompts({ [UPDATE_GOLDEN_ENV_VAR]: '0' })).toBe(false);
        expect(shouldUpdateGoldenPrompts({ [UPDATE_GOLDEN_ENV_VAR]: 'false' })).toBe(false);
        expect(shouldUpdateGoldenPrompts({ [UPDATE_GOLDEN_ENV_VAR]: '1' })).toBe(true);
        expect(shouldUpdateGoldenPrompts({ [UPDATE_GOLDEN_ENV_VAR]: 'true' })).toBe(true);
        expect(shouldUpdateGoldenPrompts({ [UPDATE_GOLDEN_ENV_VAR]: 'TRUE' })).toBe(true);
    });

    test('canonicalizes key order, prioritizes message fields, normalizes CRLF, and stabilizes only listed volatile keys', () => {
        const payload = {
            z_field: 1,
            a_field: 'line1\r\nline2',
            omitted: undefined,
            genkey: 'ephemeral-123',
            messages: [
                { content: 'Hello', extra: true, role: 'system', name: 'example_user' },
                { content: 'Hi', role: 'user' },
            ],
        };

        const canonical = canonicalizeGoldenRequest(payload, {
            volatileKeys: { genkey: '<normalized>' },
        });

        expect(Object.keys(canonical)).toEqual(['a_field', 'genkey', 'messages', 'z_field']);
        expect(canonical.a_field).toBe('line1\nline2');
        expect(canonical.genkey).toBe('<normalized>');
        expect(Object.keys(canonical.messages[0])).toEqual(['role', 'name', 'content', 'extra']);
        expect(Object.keys(canonical.messages[1])).toEqual(['role', 'content']);

        const formatted = formatGoldenJson(payload);
        expect(formatted.endsWith('\n')).toBe(true);
        expect(formatted).not.toContain('\r\n');
        expect(formatted).toContain('  "genkey": "ephemeral-123"');
    });

    test('builds a readable unified before-and-after diff', () => {
        const before = '{\n  "model": "gpt-4o",\n  "temperature": 0.8\n}\n';
        const after = '{\n  "model": "gpt-4o",\n  "temperature": 0.9\n}\n';

        expect(buildUnifiedLineDiff(before, before)).toBe('');

        const diff = buildUnifiedLineDiff(before, after, {
            expectedLabel: 'golden/sample.json',
            actualLabel: 'captured/sample.json',
        });
        expect(diff).toContain('--- golden/sample.json');
        expect(diff).toContain('+++ captured/sample.json');
        expect(diff).toContain('@@ ');
        expect(diff).toContain('-  "temperature": 0.8');
        expect(diff).toContain('+  "temperature": 0.9');
    });

    test('assertGoldenPrompt refuses to write during normal runs, updates on opt-in, and reports readable diffs on mismatch', () => {
        const dir = createTempDir();
        const baseline = {
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: 'Main prompt.' },
                { role: 'user', content: 'Hello.' },
            ],
        };

        // Missing fixture fails without writing anything in normal mode.
        expect(() => assertGoldenPrompt('sample-case', baseline, { dir, env: {} })).toThrow(/Missing golden prompt fixture/);
        expect(fs.existsSync(getGoldenFixturePath('sample-case', dir))).toBe(false);

        // Opt-in mode creates the fixture.
        const updated = assertGoldenPrompt('sample-case', baseline, {
            dir,
            env: { [UPDATE_GOLDEN_ENV_VAR]: '1' },
        });
        expect(updated.updated).toBe(true);
        expect(loadGoldenFixture('sample-case', dir)).toEqual(baseline);

        // Normal mode passes even when object keys arrive in a different order.
        const reordered = {
            messages: [
                { content: 'Main prompt.', role: 'system' },
                { content: 'Hello.', role: 'user' },
            ],
            model: 'gpt-4o',
        };
        const matched = assertGoldenPrompt('sample-case', reordered, { dir, env: {} });
        expect(matched.updated).toBe(false);
        expect(matched.matched).toBe(true);

        // Perturbed payload fails with a readable diff and never overwrites the fixture.
        const perturbed = {
            ...baseline,
            messages: [
                { role: 'system', content: 'Changed system prompt.' },
                { role: 'user', content: 'Hello.' },
            ],
        };
        expect(() => assertGoldenPrompt('sample-case', perturbed, { dir, env: {} })).toThrow(
            /- {6}"content": "Main prompt\."[\s\S]*\+ {6}"content": "Changed system prompt\."/,
        );
        expect(loadGoldenFixture('sample-case', dir)).toEqual(baseline);
    });

    test('assertGoldenPrompt appends a decoded multiline diff when a text-completion prompt changes', () => {
        const dir = createTempDir();
        assertGoldenPrompt('tc-sample', { prompt: 'Line one\nLine two\nLine three' }, {
            dir,
            env: { [UPDATE_GOLDEN_ENV_VAR]: '1' },
        });

        expect(() => assertGoldenPrompt('tc-sample', { prompt: 'Line one\nLine changed\nLine three' }, {
            dir,
            env: {},
        })).toThrow(/Decoded prompt text diff:[\s\S]*-Line two[\s\S]*\+Line changed/);
    });

    test('extractPromptText and findVolatileArtifacts handle both request shapes and detect leaks', () => {
        expect(extractPromptText({
            messages: [
                { role: 'system', content: 'Alpha' },
                { role: 'user', content: [{ type: 'text', text: 'Beta' }] },
            ],
        })).toBe('Alpha\n\nBeta');
        expect(extractPromptText({ prompt: 'Gamma' })).toBe('Gamma');
        expect(extractPromptText({})).toBe('');

        expect(findVolatileArtifacts('{"chat_id":"golden-chat-openai-full"}')).toEqual([]);
        expect(findVolatileArtifacts('{"path":"C:\\\\Users\\\\dev\\\\repo"}')).toHaveLength(1);
        expect(findVolatileArtifacts('{"path":"/Users/dev/repo"}')).toHaveLength(1);
        expect(findVolatileArtifacts('{"dir":"sillybunny-test-data-abc123"}')).toHaveLength(1);
        expect(findVolatileArtifacts('{"chat_id":"Temporary Chat: 0123456789abcdef"}')).toHaveLength(1);
        expect(findVolatileArtifacts('{"id":"550e8400-e29b-41d4-a716-446655440000"}')).toHaveLength(1);
        expect(findVolatileArtifacts('{"ts":"2026-11-27T06:21:32.123Z"}')).toHaveLength(1);
    });
});

describe('committed golden prompt fixtures', () => {
    test('fixture files on disk match GOLDEN_SCENARIOS 1:1', () => {
        const diskFiles = fs.readdirSync(GOLDEN_PROMPTS_DIR)
            .filter(name => name.endsWith('.json'))
            .sort();
        const expectedFiles = GOLDEN_SCENARIOS
            .map(scenario => `${scenario.id}.json`)
            .sort();

        expect(diskFiles).toEqual(expectedFiles);
    });

    test.each(GOLDEN_SCENARIOS)('$id parses cleanly, is canonical, has no volatile leaks, and contains expected prompt sections', (scenario) => {
        const filePath = getGoldenFixturePath(scenario.id);
        const raw = fs.readFileSync(filePath, 'utf8');

        expect(raw).not.toContain('\r\n');
        expect(raw.endsWith('\n')).toBe(true);
        expect(findVolatileArtifacts(raw)).toEqual([]);

        const fixture = JSON.parse(raw);
        expect(raw).toBe(formatGoldenJson(fixture));

        const promptText = extractPromptText(fixture);
        for (const snippet of scenario.requiredSnippets) {
            expect(promptText).toContain(snippet);
        }
        for (const forbidden of scenario.forbiddenSnippets) {
            expect(promptText).not.toContain(forbidden);
        }
    });

    test.each(GOLDEN_SCENARIOS.filter(scenario => scenario.kind === 'chat-completion'))(
        '$id has valid Chat Completion request structure',
        (scenario) => {
            const fixture = loadGoldenFixture(scenario.id);
            expect(Array.isArray(fixture.messages)).toBe(true);
            expect(fixture.messages.length).toBeGreaterThan(0);
            expect(typeof fixture.model).toBe('string');
            expect(fixture.model.length).toBeGreaterThan(0);
            expect(typeof fixture.chat_completion_source).toBe('string');
            expect(fixture.type).toBe('normal');
            expect(fixture.stream).toBe(false);
            for (const message of fixture.messages) {
                expect(typeof message.role).toBe('string');
                expect(typeof message.content).toBe('string');
                expect(message.content.trim().length).toBeGreaterThan(0);
            }
        },
    );

    test.each(GOLDEN_SCENARIOS.filter(scenario => scenario.kind === 'text-completion'))(
        '$id has valid Text Completion request structure',
        (scenario) => {
            const fixture = loadGoldenFixture(scenario.id);
            expect(typeof fixture.prompt).toBe('string');
            expect(fixture.prompt.trim().length).toBeGreaterThan(0);
            expect(typeof fixture.model).toBe('string');
            expect(typeof fixture.api_type).toBe('string');
            expect(Array.isArray(fixture.stop)).toBe(true);
            expect(Array.isArray(fixture.stopping_strings)).toBe(true);
        },
    );

    test('Chat Completion full fixtures preserve Prompt Manager section order and provider-specific fields', () => {
        const expectedCcOrder = [
            GOLDEN_FIXTURE_MARKERS.charSystemPrompt,
            GOLDEN_FIXTURE_MARKERS.mainPromptOriginal,
            GOLDEN_FIXTURE_MARKERS.worldInfoBefore,
            GOLDEN_FIXTURE_MARKERS.personaDescription,
            GOLDEN_FIXTURE_MARKERS.charDescription,
            GOLDEN_FIXTURE_MARKERS.charPersonality,
            GOLDEN_FIXTURE_MARKERS.charScenario,
            GOLDEN_FIXTURE_MARKERS.worldInfoAfter,
            '[Example Chat]',
            GOLDEN_FIXTURE_MARKERS.charExampleUser,
            GOLDEN_FIXTURE_MARKERS.charExampleAssistant,
            '[Start a new Chat]',
            GOLDEN_FIXTURE_MARKERS.chatTurn0,
            GOLDEN_FIXTURE_MARKERS.chatTurn1,
            GOLDEN_FIXTURE_MARKERS.authorsNote,
            GOLDEN_FIXTURE_MARKERS.chatTurn2,
            GOLDEN_FIXTURE_MARKERS.worldInfoAtDepth,
            GOLDEN_FIXTURE_MARKERS.chatTurn3,
            GOLDEN_FIXTURE_MARKERS.charPostHistory,
        ];

        const openai = loadGoldenFixture('chat-completion-openai-full');
        expectOrderedMarkers(extractPromptText(openai), expectedCcOrder);
        expect(openai.chat_completion_source).toBe('openai');
        expect(openai.chat_id).toBe('golden-chat-openai-full');
        expect(openai.seed).toBe(42);
        expect(openai.messages[0].content).not.toContain(GOLDEN_FIXTURE_MARKERS.worldInfoBefore);

        const claude = loadGoldenFixture('chat-completion-claude-anthropic');
        expectOrderedMarkers(extractPromptText(claude), expectedCcOrder);
        expect(claude.chat_completion_source).toBe('claude');
        expect(claude.use_sysprompt).toBe(true);
        expect(claude.assistant_prefill).toBe(GOLDEN_FIXTURE_MARKERS.claudePrefill);
        expect(claude.stop).toEqual(['\nRowan Hale:', '###']);
        expect(claude.messages[0].content).toContain(GOLDEN_FIXTURE_MARKERS.worldInfoBefore);
        expect(claude.messages[0].content).toContain(GOLDEN_FIXTURE_MARKERS.worldInfoAfter);

        const minimal = loadGoldenFixture('chat-completion-minimal-defaults');
        expect(minimal.messages).toHaveLength(5);
        expectOrderedMarkers(extractPromptText(minimal), [
            GOLDEN_FIXTURE_MARKERS.minimalMainPrompt,
            GOLDEN_FIXTURE_MARKERS.minimalDescription,
            '[Start a new Chat]',
            GOLDEN_FIXTURE_MARKERS.minimalTurn0,
            GOLDEN_FIXTURE_MARKERS.minimalTurn1,
        ]);
    });

    test('Text Completion fixtures preserve story string, depth injections, instruct wrappers, and stopping strings', () => {
        const expectedTcOrder = [
            GOLDEN_FIXTURE_MARKERS.charSystemPrompt,
            GOLDEN_FIXTURE_MARKERS.mainPromptOriginal,
            GOLDEN_FIXTURE_MARKERS.worldInfoBefore,
            GOLDEN_FIXTURE_MARKERS.charDescription,
            GOLDEN_FIXTURE_MARKERS.charPersonality,
            GOLDEN_FIXTURE_MARKERS.charScenario,
            GOLDEN_FIXTURE_MARKERS.worldInfoAfter,
            GOLDEN_FIXTURE_MARKERS.personaDescription,
            GOLDEN_FIXTURE_MARKERS.charExampleUser,
            GOLDEN_FIXTURE_MARKERS.charExampleAssistant,
            GOLDEN_FIXTURE_MARKERS.chatTurn0,
            GOLDEN_FIXTURE_MARKERS.chatTurn1,
            GOLDEN_FIXTURE_MARKERS.authorsNote,
            GOLDEN_FIXTURE_MARKERS.chatTurn2,
            GOLDEN_FIXTURE_MARKERS.worldInfoAtDepth,
            GOLDEN_FIXTURE_MARKERS.chatTurn3,
            GOLDEN_FIXTURE_MARKERS.charPostHistory,
        ];

        const instruct = loadGoldenFixture('text-completion-instruct-llama3');
        expectOrderedMarkers(instruct.prompt, expectedTcOrder);
        expect(instruct.prompt.startsWith('<|start_header_id|>system<|end_header_id|>\n\n')).toBe(true);
        expect(instruct.prompt.endsWith('<|start_header_id|>assistant<|end_header_id|>\n\n')).toBe(true);
        expect(instruct.stop).toContain('<|eot_id|>');
        expect(instruct.stop).toContain('\nRowan Hale:');

        const story = loadGoldenFixture('text-completion-story-non-instruct');
        expectOrderedMarkers(story.prompt, expectedTcOrder);
        expect(story.prompt.endsWith('\nLyra Vance:')).toBe(true);
        expect(story.stop).toEqual(['\nRowan Hale:']);
    });
});
