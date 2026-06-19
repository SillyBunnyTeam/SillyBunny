import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conversationDir = path.join(repoRoot, 'public', 'scripts', 'sillybunny-conversation');
const normalizeSource = source => source.replace(/\r\n/g, '\n');

function readConversationSource(file) {
    return normalizeSource(readFileSync(path.join(conversationDir, file), 'utf8'));
}

function getFunctionSource(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = source.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < source.length; index++) {
        const char = source[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

const generationSource = readConversationSource('generation.js');
const personasSource = readConversationSource('personas.js');
const chromeSource = readConversationSource('chrome.js');
const stateSource = readConversationSource('state.js');

describe('conversation mode scoped connection profile', () => {
    test('removes the global profile switch wrapper and slash-command helpers', () => {
        expect(personasSource).not.toContain('withConversationConnectionProfile');
        expect(personasSource).not.toContain('applyConnectionProfileByName');
        expect(personasSource).not.toContain('queueConversationProfileSwitch');
        expect(personasSource).not.toContain('quoteSlashArg');
        // The old path ran the `/profile` slash command to flip the global profile.
        expect(personasSource).not.toContain('getSelectedConnectionProfileName');
        expect(personasSource).not.toContain('/profile ');
    });

    test('drops the now-unused selected-profile name reader and switch queue', () => {
        expect(chromeSource).not.toContain('getSelectedConnectionProfileName');
        expect(stateSource).not.toContain('conversationProfileSwitchQueue');
    });

    test('exposes a scoped generateConversationRaw helper that never switches the global profile', () => {
        const helperSource = getFunctionSource(generationSource, 'generateConversationRaw');

        // Resolves the configured profile by name and routes through the scoped
        // ConnectionManagerRequestService instead of touching the global profile.
        expect(helperSource).toContain('getConnectionProfiles');
        expect(helperSource).toContain('ConnectionManagerRequestService');
        expect(helperSource).toContain('CMRS.sendRequest');
        expect(helperSource).toContain('extractData: true');
        expect(helperSource).toContain('includePreset: true');
        // It must not run the `/profile` slash command or mutate global state.
        expect(helperSource).not.toContain('/profile ');
        expect(helperSource).not.toContain('applyConnectionProfileByName');
        // Falls back to generateRaw (the active profile) when scoped path is unavailable.
        expect(helperSource).toContain('generateRaw(options)');
    });

    test('replaces every generation call site with the scoped helper', () => {
        const consumers = ['generation.js', 'interface.js', 'prompt.js', 'schedule.js', 'timeline-render.js'];
        for (const file of consumers) {
            const source = readConversationSource(file);
            expect(source).toContain('generateConversationRaw');
            expect(source).not.toContain('withConversationConnectionProfile');
        }
    });
});
