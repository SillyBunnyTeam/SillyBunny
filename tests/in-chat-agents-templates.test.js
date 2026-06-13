import fs from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

const templateDir = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const indexSourceUrl = new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url);

function readTemplate(filename) {
    return JSON.parse(fs.readFileSync(new URL(filename, templateDir), 'utf8'));
}

function readIndexSetBody(name) {
    const source = fs.readFileSync(indexSourceUrl, 'utf8');
    const match = source.match(new RegExp(`${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));

    if (!match) {
        throw new Error(`Missing set definition: ${name}`);
    }

    return match[1];
}

async function importAgentStore() {
    jest.resetModules();

    await jest.unstable_mockModule('../public/script.js', () => ({
        getRequestHeaders: jest.fn(() => ({})),
        saveSettingsDebounced: jest.fn(),
    }));

    await jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
        extension_settings: {},
        getContext: jest.fn(() => ({ groupId: null })),
    }));

    await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
        regexFromString: jest.fn(value => {
            const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
            return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
        }),
        uuidv4: jest.fn(() => 'test-uuid'),
    }));

    return await import('../public/scripts/extensions/in-chat-agents/agent-store.js');
}

function findCatalogTemplate(catalog, templateId) {
    const template = catalog.find(template => template.id === templateId);

    if (!template) {
        throw new Error(`Missing catalog template: ${templateId}`);
    }

    return template;
}

describe('in-chat agent bundled templates', () => {
    test('keeps source files synced with the template browser catalog', () => {
        const catalog = readTemplate('index.json');
        const sourceFilenames = [
            'achievements-tracker.json',
            'actor-interview-companion.json',
            'chatroom-companion.json',
            'continuity-companion.json',
            'directors-commentary-companion.json',
            'lorebook-scout-companion.json',
            'memory-shard-companion.json',
            'npc-motivator.json',
            'plot-compass-companion.json',
            'relationship-lens-companion.json',
            'scene-tracker.json',
        ];

        for (const filename of sourceFilenames) {
            const source = readTemplate(filename);
            const catalogTemplate = catalog.find(template => template.id === source.id);
            expect(catalogTemplate).toEqual(source);
        }
    });

    test('bundles NPC Motivator as an auto-loop companion agent', () => {
        const template = readTemplate('npc-motivator.json');

        expect(template).toEqual(expect.objectContaining({
            id: 'tpl-npc-motivator',
            name: 'NPC Motivator',
            author: 'Sheep',
            version: 2,
            phase: 'post',
            execution: 'companion',
            enabled: false,
        }));
        expect(template.preProcess).toBeUndefined();
        expect(template.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            rawPrompt: true,
            inlinePhase: 'pre',
            feedback: { enabled: true, depth: 1 },
            maxTokens: 4096,
        }));
        expect(template.conditions.generationTypes).toEqual(['normal', 'continue', 'impersonate']);
    });

    test('keeps Prose Polisher enabled for impersonation prompt rewrites in the catalog', () => {
        const catalog = readTemplate('index.json');
        const template = findCatalogTemplate(catalog, 'tpl-prose-polisher');

        expect(template.postProcess).toEqual(expect.objectContaining({
            promptTransformEnabled: true,
            promptTransformMode: 'rewrite',
        }));
        expect(template.conditions).toEqual(expect.objectContaining({
            runOnImpersonate: true,
        }));
    });

    test('bundles companion templates as sidecar execution agents', async () => {
        const catalog = readTemplate('index.json');
        const continuity = findCatalogTemplate(catalog, 'tpl-continuity-companion');
        const relationship = findCatalogTemplate(catalog, 'tpl-relationship-lens-companion');

        expect(continuity).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
            phase: 'post',
        }));
        expect(continuity.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'markdown',
            feedback: { enabled: true, depth: 2 },
            batch: true,
            maxTokens: 2048,
        }));
        expect(relationship.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            displayMode: 'panel',
            feedback: { enabled: false, depth: 1 },
        }));

        const commentary = findCatalogTemplate(catalog, 'tpl-directors-commentary-companion');
        const interview = findCatalogTemplate(catalog, 'tpl-actor-interview-companion');
        const lorebookScout = findCatalogTemplate(catalog, 'tpl-lorebook-scout-companion');
        const memoryShard = findCatalogTemplate(catalog, 'tpl-memory-shard-companion');
        const chatroom = findCatalogTemplate(catalog, 'tpl-chatroom-companion');

        for (const template of [commentary, interview, lorebookScout, memoryShard, chatroom]) {
            expect(template).toEqual(expect.objectContaining({
                category: 'companion',
                execution: 'companion',
                phase: 'post',
                enabled: false,
            }));
        }
        expect(commentary.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            batch: true,
        }));
        expect(interview.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            includeCharacterCard: true,
        }));
        expect(lorebookScout.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            includeWorldInfo: true,
        }));
        expect(memoryShard.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            minContextTokens: 30000,
            contextMessages: 30,
            includeHistory: true,
            feedback: { enabled: true, depth: 1 },
            maxTokens: 4096,
        }));
        expect(chatroom.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 4096,
        }));
        expect(chatroom.prompt).toContain('thread-board/4chan');
        expect(chatroom.prompt).toContain('No NSFW chat styles');

        const plotCompass = findCatalogTemplate(catalog, 'tpl-plot-compass-companion');
        expect(plotCompass).toEqual(expect.objectContaining({
            category: 'companion',
            execution: 'companion',
            phase: 'post',
            enabled: false,
        }));
        expect(plotCompass.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            rawPrompt: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: { enabled: true, depth: 1 },
        }));
        expect(plotCompass.prompt).toContain('OBJECTIVE');

        const { isCompanionAgent, normalizeAgent } = await importAgentStore();
        const saved = normalizeAgent({
            ...continuity,
            id: 'saved-continuity-companion',
            sourceTemplateId: continuity.id,
        });

        expect(saved.category).toBe('companion');
        expect(saved.execution).toBe('companion');
        expect(isCompanionAgent(saved)).toBe(true);
        expect(saved.companion.maxTokens).toBe(2048);
    });

    test('uses only known modal subcategories in the catalog', async () => {
        const { AGENT_SUBCATEGORIES } = await importAgentStore();
        const knownSubcategories = new Set(Object.keys(AGENT_SUBCATEGORIES));
        const catalog = readTemplate('index.json');
        const unknownSubcategories = catalog
            .map(template => template.subcategory)
            .filter(subcategory => subcategory !== undefined && subcategory !== null)
            .filter(subcategory => !knownSubcategories.has(subcategory));

        expect(unknownSubcategories).toEqual([]);
    });

    test('assigns tracker and content templates to modal subcategories', () => {
        const catalog = readTemplate('index.json');

        for (const template of catalog.filter(template => ['tracker', 'content'].includes(template.category))) {
            expect(typeof template.subcategory).toBe('string');
            expect(template.subcategory.trim()).not.toBe('');
        }
    });

    test('does not keep modal subcategory metadata on saved agent shapes', async () => {
        const { normalizeAgent } = await importAgentStore();
        const agent = normalizeAgent({
            id: 'saved-scene-tracker',
            name: 'Scene Tracker',
            category: 'tracker',
            subcategory: 'world',
            sourceTemplateId: 'tpl-scene-tracker',
        });

        expect(agent).not.toHaveProperty('subcategory');
    });

    test('hides Pathfinder from the in-chat template browser without purging the internal agent', () => {
        const pathfinderTemplateId = '\'tpl-pathfinder\'';

        expect(readIndexSetBody('HIDDEN_TEMPLATE_BROWSER_IDS')).toContain(pathfinderTemplateId);
        expect(readIndexSetBody('INTERNAL_BUNDLED_TEMPLATE_IDS')).toContain(pathfinderTemplateId);
        expect(readIndexSetBody('REMOVED_BUNDLED_TEMPLATE_IDS')).not.toContain(pathfinderTemplateId);
        expect(readIndexSetBody('DEFAULT_BUNDLED_TEMPLATE_IDS')).not.toContain(pathfinderTemplateId);
    });
});
