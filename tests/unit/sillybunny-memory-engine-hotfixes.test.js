import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import * as chevrotain from 'chevrotain';

await jest.unstable_mockModule('../../public/lib.js', () => ({ chevrotain, seedrandom: () => Math.random, droll: {} }));
await jest.unstable_mockModule('../../public/script.js', () => ({
    chat_metadata: {},
    main_api: '',
    extension_prompts: {},
    getCurrentChatId: () => undefined,
    getMaxContextTokens: () => 0,
    getMaxPromptTokens: () => 0,
    getMaxResponseTokens: () => 0,
}));
await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    getStringHash: () => 0,
    isFalseBoolean: arg => ['off', 'false', '0'].includes(arg?.trim()?.toLowerCase()),
    isTrueBoolean: arg => ['on', 'true', '1'].includes(arg?.trim()?.toLowerCase()),
}));
await jest.unstable_mockModule('../../public/scripts/textgen-settings.js', () => ({ textgenerationwebui_banned_in_macros: [] }));
await jest.unstable_mockModule('../../public/scripts/macros/engine/MacroDiagnostics.js', () => ({
    createMacroRuntimeError: ({ message }) => Object.assign(new Error(message), { name: 'MacroRuntimeError' }),
    logMacroGeneralError: () => {},
    logMacroInternalError: () => {},
    logMacroRegisterError: () => {},
    logMacroRegisterWarning: () => {},
    logMacroRuntimeWarning: () => {},
    logMacroSyntaxWarning: () => {},
}));

const { parseChatJsonl } = await import('../../src/chat-recovery.js');
const { createSettingsSync } = await import('../../public/scripts/sillybunny-settings-sync.js');
const { MacroEngine } = await import('../../public/scripts/macros/engine/MacroEngine.js');
const { STOP_MARKER, WHITESPACE_MARKER } = await import('../../public/scripts/macros/sillybunny-whitespace-markers.js');

const REPO_ROOT = path.resolve(process.cwd(), '..');

function readRepoFile(relativePath) {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

describe('Slice 1E: chat recovery line-streaming validation without record retention', () => {
    test('parseChatJsonl validates without allocating records when collectRecords is false', () => {
        const jsonl = [
            JSON.stringify({ user_name: 'User', character_name: 'Bot', chat_metadata: {} }),
            JSON.stringify({ name: 'Bot', mes: 'Hello world' }),
            JSON.stringify({ name: 'User', mes: 'Second message' }),
        ].join('\n');

        const result = parseChatJsonl(jsonl, { collectRecords: false });
        expect(result.status).toBe('ok');
        expect(result.records).toBeNull();
    });

    test('parseChatJsonl still rejects malformed lines when collectRecords is false', () => {
        const badJsonl = [
            JSON.stringify({ chat_metadata: {} }),
            '{not valid json',
        ].join('\n');

        const result = parseChatJsonl(badJsonl, { collectRecords: false });
        expect(result).toMatchObject({ status: 'corrupt', reason: 'invalid-json', line: 2 });
    });

    test('chat save/delete routes keep identical-content fast path and simple listing metadata', () => {
        const chatsSource = readRepoFile('src/endpoints/chats.js');
        const charactersSource = readRepoFile('src/endpoints/characters.js');
        const scriptSource = readRepoFile('public/script.js');

        expect(chatsSource).toContain('if (typeof left === \'string\' && typeof right === \'string\' && left.length > 0 && left === right)');
        expect(charactersSource).toContain('return { file_name: file, file_id: path.parse(file).name, last_mes: lastMes };');
        expect(scriptSource).toContain('body: JSON.stringify({ avatar_url: character.avatar, file_name: fileName, simple: true })');
        expect(scriptSource).toContain('body: JSON.stringify({ avatar_url: character.avatar, simple: true })');
        expect(scriptSource).toContain('unobserveChatMessageResize(firstDeleted);');
        expect(scriptSource).toContain('unobserveChatMessageResize(followingDeleted);');
    });
});

describe('Slice 1E: compact streaming SHA-256 settings sync fingerprints', () => {
    test('returns a fixed-size digest regardless of payload size while matching canonical equality', () => {
        const sync = createSettingsSync();
        const hugeText = 'x'.repeat(250_000);
        const firstJson = JSON.stringify({ _version: 1, z: hugeText, a: { c: 3, b: [1, 2] } });
        const secondJson = JSON.stringify({ a: { b: [1, 2], c: 3 }, z: hugeText, _version: 99 });
        const changedJson = JSON.stringify({ a: { b: [1, 3], c: 3 }, z: hugeText, _version: 99 });

        const fp1 = sync.getFingerprint(firstJson);
        const fp2 = sync.getFingerprint(secondJson);
        const fp3 = sync.getFingerprint(changedJson);

        expect(fp1).toMatch(/^v1:\d+:[a-f0-9]{64}$/);
        expect(fp1.length).toBeLessThan(100);
        expect(fp1).toBe(fp2);
        expect(fp1).not.toBe(fp3);

        sync.remember(fp1);
        expect(sync.isSynced(fp2)).toBe(true);
        expect(sync.isSynced(fp3)).toBe(false);
    });
});

describe('Slice 1E: MacroEngine plain-text fast path', () => {
    test('fast-returns plain strings while preserving legacy markers, escapes, whitespace markers, and custom processors', () => {
        expect(MacroEngine.canFastReturnPlainText('Plain message with 123 and <b>html</b>')).toBe(true);
        expect(MacroEngine.canFastReturnPlainText('Hello {{user}}')).toBe(false);
        expect(MacroEngine.canFastReturnPlainText('Hello <USER>')).toBe(false);
        expect(MacroEngine.canFastReturnPlainText('Hello <bot>')).toBe(false);
        expect(MacroEngine.canFastReturnPlainText('Escaped \\{brace\\}')).toBe(false);
        expect(MacroEngine.canFastReturnPlainText(`marked ${WHITESPACE_MARKER}`)).toBe(false);
        expect(MacroEngine.canFastReturnPlainText(`stopped ${STOP_MARKER}`)).toBe(false);

        const customHandler = jest.fn(text => text.replace('foo', 'bar'));
        MacroEngine.addPreProcessor(customHandler, { source: 'test:custom' });
        try {
            expect(MacroEngine.canFastReturnPlainText('foo')).toBe(false);
            expect(MacroEngine.evaluate('foo', { dynamicMacros: {} })).toBe('bar');
            expect(customHandler).toHaveBeenCalledTimes(1);
        } finally {
            MacroEngine.removePreProcessor(customHandler);
        }

        expect(MacroEngine.canFastReturnPlainText('foo')).toBe(true);
        expect(MacroEngine.evaluate('foo', { dynamicMacros: {} })).toBe('foo');
    });
});

describe('Slice 1E: bounded session caches and World Info fast paths', () => {
    test('itemized-prompts, backgrounds, tokenizers, and world-info wire cache bounds and caches', () => {
        const itemizedSource = readRepoFile('public/scripts/itemized-prompts.js');
        const backgroundsSource = readRepoFile('public/scripts/backgrounds.js');
        const tokenizersSource = readRepoFile('public/scripts/tokenizers.js');
        const worldInfoSource = readRepoFile('public/scripts/world-info.js');

        expect(itemizedSource).toContain('export const MAX_ITEMIZED_PROMPTS = 50;');
        expect(itemizedSource).toContain('export function trimItemizedPrompts(');

        expect(backgroundsSource).toContain('const MAX_THUMBNAIL_BLOB_URLS = 64;');
        expect(backgroundsSource).toContain('function cacheThumbnailBlobUrl(');
        expect(backgroundsSource).toContain('URL.revokeObjectURL(evictUrl);');

        expect(tokenizersSource).toContain('const MAX_TOKEN_CACHE_CHATS = 20;');
        expect(tokenizersSource).toContain('const MAX_TOKEN_CACHE_ENTRIES_PER_CHAT = 500;');
        expect(tokenizersSource).toContain('eventSource.on(event_types.CHAT_DELETED');

        expect(worldInfoSource).toContain('static #wholeWordRegexCache = new Map();');
        expect(worldInfoSource).toContain('#haystackCache = new Map();');
        expect(worldInfoSource).toContain('#lowerHaystackCache = new Map();');
        expect(worldInfoSource).toContain('if (typeof input !== \'string\' || input.charCodeAt(0) !== 47)');
    });
});
