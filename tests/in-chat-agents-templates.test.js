import fs from 'node:fs';
import { describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    regexFromString: jest.fn(value => {
        const match = String(value ?? '').match(/^\/([\s\S]*)\/([a-z]*)$/i);
        return match ? new RegExp(match[1], match[2]) : new RegExp(String(value ?? ''));
    }),
    uuidv4: jest.fn(() => 'test-uuid'),
}));

const {
    AGENT_REGEX_PLACEMENT,
    applyRegexScriptList,
} = await import('../public/scripts/extensions/in-chat-agents/regex-scripts.js');

const templateDir = new URL('../public/scripts/extensions/in-chat-agents/templates/', import.meta.url);
const indexSourceUrl = new URL('../public/scripts/extensions/in-chat-agents/index.js', import.meta.url);
const sourceFilenames = [
    'achievements-tracker.json',
    'actor-interview-companion.json',
    'chat-only-companion.json',
    'chatroom-companion.json',
    'continuity-companion.json',
    'directors-commentary-companion.json',
    'lorebook-scout-companion.json',
    'memory-shard-companion.json',
    'message-inbox-companion.json',
    'npc-motivator.json',
    'plot-compass-companion.json',
    'relationship-lens-companion.json',
    'scene-tracker.json',
];

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

function renderChatroomOutput(source) {
    const chatroom = readTemplate('chatroom-companion.json');
    return applyRegexScriptList(source, chatroom.regexScripts, AGENT_REGEX_PLACEMENT.AI_OUTPUT, {
        isMarkdown: true,
    });
}

describe('in-chat agent bundled templates', () => {
    test('keeps source files synced with the template browser catalog', () => {
        const catalog = readTemplate('index.json');

        for (const filename of sourceFilenames) {
            const source = readTemplate(filename);
            const catalogTemplate = catalog.find(template => template.id === source.id);
            expect(catalogTemplate).toEqual(source);
        }
    });

    test('keeps bundled companion prompts free of negative wrappers and uppercase protocols', () => {
        const companionFilenames = sourceFilenames.filter(filename => filename.includes('companion') || filename === 'npc-motivator.json');
        const negativeWrapperPattern = /\b(?:Do not|Don't|Never|Return only|Output only|strictly|AI agent|as an AI|LLM)\b/i;
        const uppercaseProtocolPattern = /\b(?:CHATROOM_STYLE|CHATROOM_END|PHONE_NONE|PHONE_START|PHONE_TEXT|PHONE_END|LETTER_START|LETTER_TEXT|LETTER_END|OBJECTIVE:|## TIMELINE|## CHARACTERS|## RELATIONSHIPS|## EVENTS|## DIALOGUE KEYS|## THREADS|## NOW)\b/;
        const vagueCompanionPromptPattern = /\b(?:shape|shapes|pressure|pressures|beat|beats)\b/i;

        for (const filename of companionFilenames) {
            const template = readTemplate(filename);
            const prompt = String(template.prompt ?? '');
            expect(prompt).not.toMatch(negativeWrapperPattern);
            expect(prompt).not.toMatch(uppercaseProtocolPattern);
            expect(prompt).not.toMatch(vagueCompanionPromptPattern);
        }
    });

    test('keeps draft companion template versions at v1', () => {
        const companionFilenames = sourceFilenames.filter(filename => filename.includes('companion') || filename === 'npc-motivator.json');

        for (const filename of companionFilenames) {
            const template = readTemplate(filename);
            expect(template.version).toBe(1);
        }
    });

    test('bundles NPC Motivator as an auto-loop companion agent', () => {
        const template = readTemplate('npc-motivator.json');

        expect(template).toEqual(expect.objectContaining({
            id: 'tpl-npc-motivator',
            name: 'NPC Motivator',
            author: 'Sheep',
            version: 1,
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
            maxTokens: 32000,
        }));
        expect(template.conditions.generationTypes).toEqual(['normal', 'continue', 'impersonate']);
    });

    test('keeps choice-menu templates from including the system prompt by default', () => {
        const catalog = readTemplate('index.json');

        for (const templateId of ['tpl-cyoa-choices', 'tpl-direction-menu']) {
            const template = findCatalogTemplate(catalog, templateId);
            expect(template.companion).toEqual(expect.objectContaining({
                includeSystemPrompt: false,
            }));
            expect(template.prompt).toContain('repair task');
            expect(template.prompt).not.toContain('End EVERY');
            expect(template.prompt).not.toContain('EXACT');
        }
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
            maxTokens: 32000,
        }));
        expect(relationship.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            displayMode: 'panel',
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            feedback: { enabled: false, depth: 1 },
        }));

        const commentary = findCatalogTemplate(catalog, 'tpl-directors-commentary-companion');
        const interview = findCatalogTemplate(catalog, 'tpl-actor-interview-companion');
        const lorebookScout = findCatalogTemplate(catalog, 'tpl-lorebook-scout-companion');
        const memoryShard = findCatalogTemplate(catalog, 'tpl-memory-shard-companion');
        const chatroom = findCatalogTemplate(catalog, 'tpl-chatroom-companion');
        const chatOnly = findCatalogTemplate(catalog, 'tpl-chat-only-companion');
        const messageInbox = findCatalogTemplate(catalog, 'tpl-message-inbox-companion');

        for (const template of [commentary, interview, lorebookScout, memoryShard, chatroom, chatOnly, messageInbox]) {
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
        expect(commentary.prompt).toContain('[Selected Director Commentary Voice]');
        expect(commentary.prompt).toContain('[Director Commentary Voice]');
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
            maxTokens: 32000,
        }));
        expect(chatroom.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeWorldInfo: true,
            includeHistory: true,
            historyDepth: 1,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 32000,
        }));
        expect(chatroom.regexScripts).toHaveLength(6);
        expect(chatroom.prompt).toContain('chatroom-style|active-style');
        expect(chatroom.prompt).toContain('chatroom|speaker|meta|tone|message');
        expect(chatroom.prompt).toContain('message field on one line');
        expect(chatroom.prompt).toContain('[Chatroom Extra Character Cards]');
        expect(chatroom.prompt).toContain('[Custom Chatroom Style]');
        expect(chatroom.prompt).toContain('- custom: follow [Custom Chatroom Style]');
        expect(chatroom.prompt).toContain('thread-board/4chan');
        expect(chatroom.prompt).toContain('Use unique post labels instead of repeating Anon');
        expect(chatroom.prompt).toContain('- reddit:');
        expect(chatroom.regexScripts.map(script => script.id)).toContain('chatroom-message-row-greentext');
        expect(chatroom.regexScripts.map(script => script.id)).toContain('chatroom-greentext-continuation');
        expect(chatroom.prompt).not.toContain('No NSFW chat styles');
        expect(chatroom.prompt).not.toContain('targeted slurs');

        expect(chatOnly.companion).toEqual(expect.objectContaining({
            trigger: 'manual',
            displayMode: 'panel',
            format: 'markdown',
            rawPrompt: true,
            includeCharacterCard: true,
            includePersona: true,
            includeWorldInfo: true,
            includeAuthorsNote: true,
            includeHistory: true,
            historyDepth: 6,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 32000,
        }));
        expect(chatOnly.prompt).toContain('private side-channel conversation');
        expect(chatOnly.prompt).toContain('[Your previous notes]');
        expect(chatOnly.prompt).toContain('Chat Only textbox');
        expect(chatOnly.prompt).toContain('[Chat Only side chat]');
        expect(chatOnly.prompt).toContain('You: the user\'s newest aside');
        expect(chatOnly.prompt).toContain('Actions appear as plain prose');
        expect(chatOnly.prompt).toContain('live side chat panel');
        expect(chatOnly.prompt).not.toContain('**You:**');

        expect(messageInbox.companion).toEqual(expect.objectContaining({
            trigger: 'auto',
            displayMode: 'panel',
            format: 'html',
            rawPrompt: true,
            includeWorldInfo: true,
            includeAuthorsNote: true,
            includeHistory: false,
            feedback: { enabled: false, depth: 1 },
            maxTokens: 32000,
        }));
        expect(messageInbox.regexScripts).toHaveLength(6);
        expect(messageInbox.prompt).toContain('phone-none');
        expect(messageInbox.prompt).toContain('phone-start|thread-title|status');
        expect(messageInbox.prompt).toContain('letter-start|title-or-seal|status');
        expect(messageInbox.prompt).toContain('fantasy, medieval');
        expect(messageInbox.regexScripts.map(script => script.id)).toEqual(expect.arrayContaining([
            'message-inbox-phone-shell-open',
            'message-inbox-phone-text-row',
            'message-inbox-letter-shell-open',
            'message-inbox-letter-text-row',
        ]));

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
            maxTokens: 32000,
        }));
        expect(plotCompass.prompt).toContain('[Plot Compass Objective]');
        expect(plotCompass.prompt).not.toContain('first line of [Your previous notes]');

        const { isCompanionAgent, normalizeAgent } = await importAgentStore();
        const saved = normalizeAgent({
            ...continuity,
            id: 'saved-continuity-companion',
            sourceTemplateId: continuity.id,
        });

        expect(saved.category).toBe('companion');
        expect(saved.execution).toBe('companion');
        expect(isCompanionAgent(saved)).toBe(true);
        expect(saved.companion.maxTokens).toBe(32000);
    });

    test('renders orphan greentext continuation lines inside the Chatroom interface', () => {
        const html = renderChatroomOutput([
            'chatroom-style|thread-board/4chan',
            'chatroom|Anon #009|checked|18|>be the Martyred Maiden',
            '>spend your free time sharpening a sword and eating sweets',
            'chatroom-end',
        ].join('\n'));

        expect(html).toContain('>be the Martyred Maiden');
        expect(html).toContain('>spend your free time sharpening a sword and eating sweets');
        expect(html).toContain('font-family:ui-monospace');
        expect(html).toContain('grid-template-columns:minmax(86px,auto) 1fr');
        expect(html).not.toMatch(/^>spend your free time/m);
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
