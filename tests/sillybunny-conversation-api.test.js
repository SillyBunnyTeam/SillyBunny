import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES, SETTINGS_FILE, TEXTGEN_TYPES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import { CONVERSATION_STORE_KEY, DEFAULT_BRANCH_ID } from '../public/scripts/sillybunny-conversation/constants.js';
import { validateStoreStructure } from '../src/endpoints/conversation-utils.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

const triggerSettingsBackup = jest.fn();
await jest.unstable_mockModule('../src/endpoints/settings.js', () => ({ triggerAutoSave: triggerSettingsBackup }));

function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address()));
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        if (!server) {
            resolve();
            return;
        }

        server.close((error) => error ? reject(error) : resolve());
    });
}

async function readRequestJson(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

describe('SillyBunny Conversation REST API', () => {
    /** @type {import('http').Server} */
    let appServer;
    /** @type {import('http').Server} */
    let upstreamServer;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let userDirectories;
    let baseUrl;
    let aliasBaseUrl;
    let upstreamUrl;
    let upstreamReplyText;
    let upstreamResponseDelayMs;
    let upstreamResponseStatus;
    let userHandle;
    const upstreamRequests = [];
    const tempDirs = [];

    beforeAll(async () => {
        const { router } = await import('../src/endpoints/sillybunny-conversation.js');

        upstreamServer = http.createServer(async (request, response) => {
            if (request.method !== 'POST' || !['/v1/responses', '/v1/completions', '/v1/chat/completions'].includes(request.url)) {
                response.writeHead(404);
                response.end();
                return;
            }

            const body = await readRequestJson(request);
            upstreamRequests.push(body);
            if (upstreamResponseDelayMs) {
                await new Promise(resolve => setTimeout(resolve, upstreamResponseDelayMs));
            }
            if (upstreamResponseStatus !== 200) {
                response.writeHead(upstreamResponseStatus, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { type: 'upstream_test_error', message: 'Upstream rejected the request' } }));
                return;
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            if (request.url === '/v1/completions') {
                response.end(JSON.stringify({ choices: [{ text: upstreamReplyText }] }));
                return;
            }
            if (request.url === '/v1/chat/completions') {
                response.end(JSON.stringify({ choices: [{ message: { content: upstreamReplyText } }] }));
                return;
            }
            response.end(JSON.stringify({
                id: 'resp-conversation-test',
                model: body.model,
                status: 'completed',
                output: [{
                    type: 'message',
                    content: [{
                        type: 'output_text',
                        text: upstreamReplyText,
                    }],
                }],
                usage: {
                    input_tokens: 7,
                    output_tokens: 3,
                },
            }));
        });
        const upstreamAddress = await listen(upstreamServer);
        upstreamUrl = `http://127.0.0.1:${upstreamAddress.port}/v1/`;

        const app = express();
        app.use(express.json({ limit: '150mb' }));
        app.use((request, _response, next) => {
            request.user = { directories: userDirectories, profile: { handle: userHandle } };
            next();
        });
        app.use('/api/sillybunny-conversation', router);
        app.use('/api/sillybunny/conversation', router);

        appServer = http.createServer(app);
        const appAddress = await listen(appServer);
        baseUrl = `http://127.0.0.1:${appAddress.port}/api/sillybunny-conversation`;
        aliasBaseUrl = `http://127.0.0.1:${appAddress.port}/api/sillybunny/conversation`;
    });

    beforeEach(() => {
        triggerSettingsBackup.mockClear();
        upstreamRequests.length = 0;
        upstreamReplyText = 'Hello from Nova.';
        upstreamResponseDelayMs = 0;
        upstreamResponseStatus = 200;

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-conversation-api-'));
        tempDirs.push(root);
        userHandle = path.basename(root);
        userDirectories = {
            root,
            backups: path.join(root, 'backups'),
            characters: path.join(root, 'characters'),
            groups: path.join(root, 'groups'),
            userImages: path.join(root, 'user', 'images'),
        };
        fs.mkdirSync(userDirectories.backups, { recursive: true });
        fs.mkdirSync(userDirectories.characters, { recursive: true });
        fs.mkdirSync(userDirectories.groups, { recursive: true });
        fs.mkdirSync(userDirectories.userImages, { recursive: true });
        fs.writeFileSync(path.join(root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {},
        }, null, 4));
    });

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        userDirectories = undefined;
    });

    afterAll(async () => {
        await close(appServer);
        await close(upstreamServer);
    });

    async function postJson(endpoint, body) {
        return fetch(`${baseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    async function postAliasJson(endpoint, body) {
        return fetch(`${aliasBaseUrl}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    function readSettings() {
        return JSON.parse(fs.readFileSync(path.join(userDirectories.root, SETTINGS_FILE), 'utf8'));
    }

    function readConversationStore() {
        return readSettings().extension_settings[CONVERSATION_STORE_KEY];
    }

    function getChatGeneration() {
        return {
            backend: 'chat',
            payload: {
                chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                reverse_proxy: upstreamUrl,
                proxy_password: 'test-key',
                model: 'gpt-5.4',
                temperature: 1,
                top_p: 1,
                max_tokens: 64,
            },
        };
    }

    async function waitForUpstreamRequests(count) {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (upstreamRequests.length >= count) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('Timed out waiting for upstream request');
    }

    test('info describes browser-primary and curl-capable REST paths', async () => {
        const response = await postJson('/info', {});

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.primaryPath).toMatchObject({
            type: 'browser-client',
            usesRestApiAsPrimaryDriver: false,
        });
        expect(json.primaryPath.flow.map(step => step.function)).toEqual(expect.arrayContaining([
            'submitConversationInput',
            'appendConversationThreadMessage',
            'processSendQueue',
            'generateConversationRaw',
        ]));
        expect(json.primaryPath.flow.find(step => step.step === 'queue-reply')?.file)
            .toBe('public/scripts/sillybunny-conversation/attachments.js');
        const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
        expect(json.primaryPath.flow.every(step => fs.existsSync(path.join(repositoryRoot, step.file)))).toBe(true);
        expect(json.restPath).toMatchObject({
            type: 'json-rest',
            curlDriven: true,
            basePath: '/api/sillybunny-conversation',
            aliasBasePaths: ['/api/sillybunny/conversation'],
        });
        expect(json.restPath.endpoints.map(endpoint => endpoint.path)).toEqual(expect.arrayContaining([
            '/info',
            '/store/get',
            '/message/send',
        ]));
        expect(json.caveats.join(' ')).toContain('Browser-only automation');
        expect(json.caveats.join(' ')).toContain('Bracket commands are extracted');

        const aliasResponse = await postAliasJson('/info', {});
        expect(aliasResponse.status).toBe(200);
        await expect(aliasResponse.json()).resolves.toMatchObject({ feature: 'Conversation Mode' });
    });

    test('store/get returns the current Conversation Mode store shape', async () => {
        const response = await postJson('/store/get', {});

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(0);
        expect(json.store).toMatchObject({
            version: 1,
            localStorageMigrated: false,
            settings: {},
            characters: {},
            groups: [],
            reminders: [],
        });
        expect(readSettings().extension_settings[CONVERSATION_STORE_KEY]).toBeUndefined();
    });

    test('thread/get create persists a versioned thread atomically', async () => {
        const missingVersionResponse = await postJson('/thread/get', { avatar: 'nova.png', create: true });
        expect(missingVersionResponse.status).toBe(400);
        await expect(missingVersionResponse.json()).resolves.toEqual({ error: 'version_required' });

        const response = await postJson('/thread/get', {
            avatar: 'nova.png',
            create: true,
            version: 0,
        });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(1);
        expect(json.thread.activeBranchId).toBe(DEFAULT_BRANCH_ID);
        expect(readSettings()._version).toBe(1);
        expect(readConversationStore().characters['nova.png']).toBeTruthy();
    });

    test('group/create persists Conversation-owned groups without creating roleplay group files', async () => {
        const createResponse = await postJson('/group/create', {
            name: 'Nova and Echo',
            members: ['nova.png', 'echo.png'],
            version: 0,
        });

        expect(createResponse.status).toBe(200);
        const createJson = await createResponse.json();
        expect(createJson.version).toBe(1);
        expect(createJson.group).toMatchObject({
            name: 'Nova and Echo',
            members: ['nova.png', 'echo.png'],
            is_conversation_group: true,
            conversation_settings: {
                multi_char: true,
                auto_character_chat: true,
            },
        });
        expect(fs.readdirSync(userDirectories.groups)).toEqual([]);

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: createJson.group.id,
            text: 'group-only hello',
            version: 1,
        });

        expect(appendResponse.status).toBe(200);
        const appendJson = await appendResponse.json();
        expect(appendJson.version).toBe(2);
        expect(appendJson.threadKey).toBe(`group:${createJson.group.id}:nova.png`);

        const store = readConversationStore();
        expect(store.groups).toHaveLength(1);
        expect(store.groups[0].id).toBe(createJson.group.id);
        expect(store.characters[`group:${createJson.group.id}:nova.png`].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('group-only hello');
        expect(fs.readdirSync(userDirectories.groups)).toEqual([]);
    });

    test('message/send adds group reference context for unnamed replies', async () => {
        upstreamReplyText = 'I was talking about the keys.';

        const createResponse = await postJson('/group/create', {
            name: 'Alhaitham and Kaveh',
            members: ['alhaitham.png', 'Kaveh.png', 'Cyno.png'],
            version: 0,
        });
        const createJson = await createResponse.json();

        const saveResponse = await postJson('/thread/save', {
            avatar: 'alhaitham.png',
            groupId: createJson.group.id,
            version: 1,
            messages: [{
                role: 'partner',
                name: 'Kaveh',
                mes: 'I hid the keys.',
                extra: { partner_avatar: 'kaveh.png' },
            }],
        });
        expect(saveResponse.status).toBe(200);

        const sendResponse = await postJson('/message/send', {
            avatar: 'alhaitham.png',
            groupId: createJson.group.id,
            text: 'why did you do that?',
            userName: 'Riley',
            version: 2,
            character: { data: { name: 'Alhaitham' } },
            generation: {
                backend: 'chat',
                payload: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    reverse_proxy: upstreamUrl,
                    proxy_password: 'test-key',
                    model: 'gpt-5.4',
                    temperature: 1,
                    top_p: 1,
                    max_tokens: 64,
                },
            },
            includePrompt: true,
        });

        expect(sendResponse.status).toBe(200);
        const sendJson = await sendResponse.json();
        const contextMessage = sendJson.prompt.messages.find(message => message.identifier === 'conversation-group-reference-context');
        expect(contextMessage).toBeTruthy();
        expect(contextMessage.content).toContain('Latest user message: why did you do that?');
        expect(contextMessage.content).toContain('most likely addresses Kaveh');
        expect(contextMessage.content).toContain('do not assume every you means Alhaitham');
        expect(sendJson.prompt.systemPrompt).toContain('Active group participants:');
        expect(sendJson.prompt.systemPrompt).toContain('Alhaitham');
        expect(sendJson.prompt.systemPrompt).toContain('Kaveh');
        expect(sendJson.prompt.systemPrompt).toContain('Cyno');
        expect(JSON.stringify(upstreamRequests[0])).toContain('Group DM reference context');
    });

    test('group participant prompts dedupe and cap large authorized groups while retaining the current speaker', async () => {
        const groupId = 'large-legacy-group';
        const members = [
            ...Array.from({ length: 80 }, (_, index) => `Member-${index}.png`),
            'Member-0.png',
            'Member-1.png',
            'Speaker.png',
        ];
        fs.writeFileSync(path.join(userDirectories.groups, `${groupId}.json`), JSON.stringify({
            id: groupId,
            members,
            disabled_members: [],
        }));

        const response = await postJson('/message/send', {
            avatar: 'Speaker.png',
            groupId,
            text: 'Hello large group',
            version: 0,
            character: { name: 'Current Speaker' },
            generation: getChatGeneration(),
            includePrompt: true,
        });
        expect(response.status).toBe(200);
        const json = await response.json();
        const participantLine = json.prompt.systemPrompt
            .split('\n')
            .find(line => line.startsWith('Active group participants:'));
        const participantNames = participantLine
            .replace(/^Active group participants:\s*/, '')
            .replace(/\.$/, '')
            .split(', ');
        expect(participantNames).toContain('Current Speaker');
        expect(participantNames).toHaveLength(32);
        expect(new Set(participantNames.map(name => name.toLowerCase())).size).toBe(participantNames.length);
        expect(participantNames.join(', ').length).toBeLessThanOrEqual(2048);
    });

    test('message/append persists a user message in the existing settings schema', async () => {
        const response = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'hello from curl',
            userName: 'Riley',
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(1);
        expect(json.threadKey).toBe('nova.png');
        expect(json.message).toMatchObject({
            role: 'user',
            name: 'Riley',
            mes: 'hello from curl',
        });

        const settings = readSettings();
        expect(settings._version).toBe(1);
        const branch = settings.extension_settings[CONVERSATION_STORE_KEY]
            .characters['nova.png']
            .branches[DEFAULT_BRANCH_ID];
        expect(branch.messages).toHaveLength(1);
        expect(branch.preview).toBe('hello from curl');
    });

    test('conversation writes preserve unrelated current settings', async () => {
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            theme: 'keep-me',
            extension_settings: {
                unrelated_extension: { enabled: true },
            },
        }, null, 4));

        const response = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'conversation-only mutation',
            version: 0,
        });
        expect(response.status).toBe(200);

        const settings = readSettings();
        expect(settings.theme).toBe('keep-me');
        expect(settings.extension_settings.unrelated_extension).toEqual({ enabled: true });
    });

    test('browser-owned Conversation store fields and future fields round-trip', async () => {
        const browserStore = {
            version: 1,
            localStorageMigrated: true,
            settings: { enabled: true },
            characters: {
                'attachment.png': {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: [{
                                id: 'attachment-message',
                                role: 'user',
                                mes: 'valid attachment metadata',
                                extra: {
                                    media: [{ url: 'https://example.com/legacy.png' }, { url: 'https://example.com/image.png', type: 'image' }],
                                    files: [{ url: 'https://example.com/file.txt', name: 'file.txt' }],
                                },
                            }],
                        },
                    },
                },
            },
            groups: [],
            legacyThreadPersonaAssignments: {
                'legacy char%: one.png': 'persona one%:.png',
            },
            reminders: [],
            userStatus: 'idle',
            userPersonaStatus: 'Working on tests',
            futureBrowserState: { enabled: true },
        };

        const saveResponse = await postJson('/store/save', { store: browserStore, version: 0 });
        expect(saveResponse.status).toBe(200);
        const savedStore = readConversationStore();
        expect(savedStore.legacyThreadPersonaAssignments).toEqual(browserStore.legacyThreadPersonaAssignments);
        expect(savedStore.userStatus).toBe('idle');
        expect(savedStore.userPersonaStatus).toBe('Working on tests');
        expect(savedStore.futureBrowserState).toEqual({ enabled: true });
        expect(savedStore.characters).toEqual(browserStore.characters);

        const getResponse = await postJson('/store/get', {});
        expect(getResponse.status).toBe(200);
        await expect(getResponse.json()).resolves.toMatchObject({
            store: {
                legacyThreadPersonaAssignments: browserStore.legacyThreadPersonaAssignments,
                userStatus: 'idle',
                userPersonaStatus: 'Working on tests',
                futureBrowserState: { enabled: true },
            },
        });
    });

    test('persisted store limits accommodate multiple full threads and stores above the request envelope', async () => {
        const makeMessages = threadIndex => Array.from({ length: 250 }, (_, messageIndex) => ({
            id: `thread-${threadIndex}-message-${messageIndex}`,
            role: 'user',
            name: 'Riley',
            mes: `message ${messageIndex}`,
        }));
        const complexStore = {
            version: 1,
            settings: {},
            groups: [],
            reminders: [],
            characters: Object.fromEntries(Array.from({ length: 6 }, (_, threadIndex) => [
                `character-${threadIndex}.png`,
                {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: makeMessages(threadIndex),
                        },
                    },
                },
            ])),
        };
        expect(validateStoreStructure(complexStore)).toEqual({ valid: true });

        const saveResponse = await postJson('/store/save', { store: complexStore, version: 0 });
        expect(saveResponse.status).toBe(200);
        expect(Object.keys(readConversationStore().characters)).toHaveLength(6);

        const largeStore = {
            version: 1,
            settings: {},
            groups: [],
            reminders: [],
            characters: {
                'large.png': {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: Array.from({ length: 97 }, (_, index) => ({
                                id: `large-message-${index}`,
                                role: 'user',
                                mes: 'x'.repeat(256 * 1024),
                            })),
                        },
                    },
                },
            },
        };
        expect(validateStoreStructure(largeStore)).toEqual({ valid: true });
        const largeSaveResponse = await postJson('/store/save/', { store: largeStore, version: 1 });
        expect(largeSaveResponse.status).toBe(200);
        expect((await largeSaveResponse.json()).version).toBe(2);
        expect(readConversationStore().characters['large.png'].branches[DEFAULT_BRANCH_ID].messages).toHaveLength(97);
    });

    test('personaId scopes solo and group Conversation storage independently', async () => {
        const rileyResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            personaId: 'riley.png',
            text: 'hello from Riley',
            userName: 'Riley',
            version: 0,
        });

        expect(rileyResponse.status).toBe(200);
        const rileyJson = await rileyResponse.json();
        expect(rileyJson.threadKey).toBe('persona:riley.png:nova.png');

        const morganResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            personaId: 'morgan.png',
            text: 'hello from Morgan',
            userName: 'Morgan',
            version: 1,
        });

        expect(morganResponse.status).toBe(200);
        const morganJson = await morganResponse.json();
        expect(morganJson.threadKey).toBe('persona:morgan.png:nova.png');

        const createGroupResponse = await postJson('/group/create', {
            personaId: 'riley.png',
            name: 'Riley group',
            members: ['nova.png', 'echo.png'],
            version: 2,
        });

        expect(createGroupResponse.status).toBe(200);
        const createGroupJson = await createGroupResponse.json();
        expect(createGroupJson.group.personaId).toBe('riley.png');

        const rileyGroupsResponse = await postJson('/group/list', { personaId: 'riley.png' });
        const rileyGroupsJson = await rileyGroupsResponse.json();
        expect(rileyGroupsJson.groups.map(group => group.id)).toEqual([createGroupJson.group.id]);

        const morganGroupsResponse = await postJson('/group/list', { personaId: 'morgan.png' });
        const morganGroupsJson = await morganGroupsResponse.json();
        expect(morganGroupsJson.groups).toEqual([]);

        const groupAppendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: createGroupJson.group.id,
            personaId: 'riley.png',
            text: 'persona-scoped group hello',
            version: 3,
        });

        expect(groupAppendResponse.status).toBe(200);
        const groupAppendJson = await groupAppendResponse.json();
        expect(groupAppendJson.threadKey).toBe(`persona:riley.png:group:${createGroupJson.group.id}:nova.png`);

        const store = readConversationStore();
        expect(store.characters['persona:riley.png:nova.png'].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('hello from Riley');
        expect(store.characters['persona:morgan.png:nova.png'].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('hello from Morgan');
        expect(store.characters[`persona:riley.png:group:${createGroupJson.group.id}:nova.png`].branches[DEFAULT_BRANCH_ID].messages[0].mes).toBe('persona-scoped group hello');
        expect(store.characters['nova.png']).toBeUndefined();
    });

    test('persona writes migrate assigned unscoped solo and group threads without losing scoped history', async () => {
        const personaId = 'riley:main.png';
        const scopedSoloKey = `persona:${encodeURIComponent(personaId)}:nova.png`;
        const groupId = 'legacy-conversation-group';
        const unscopedGroupKey = `group:${groupId}:nova.png`;
        const makeThread = (id, mes, createdAt) => ({
            activeBranchId: DEFAULT_BRANCH_ID,
            branches: {
                [DEFAULT_BRANCH_ID]: {
                    id: DEFAULT_BRANCH_ID,
                    messages: [{ id, role: 'user', name: 'Riley', mes, created_at: createdAt }],
                },
            },
        });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    characters: {
                        'nova.png': makeThread('legacy-solo', 'legacy solo history', 1),
                        [scopedSoloKey]: makeThread('scoped-solo', 'scoped solo history', 2),
                        [unscopedGroupKey]: makeThread('legacy-group', 'legacy group history', 1),
                    },
                    groups: [{
                        id: groupId,
                        personaId,
                        members: ['nova.png', 'echo.png'],
                        disabled_members: [],
                    }],
                    legacyThreadPersonaAssignments: {
                        'nova.png': personaId,
                        [unscopedGroupKey]: personaId,
                    },
                    reminders: [],
                },
            },
        }, null, 4));

        const soloResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            personaId,
            id: 'new-solo',
            text: 'new solo message',
            version: 0,
        });
        expect(soloResponse.status).toBe(200);
        expect((await soloResponse.json()).threadKey).toBe(scopedSoloKey);

        const groupResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId,
            personaId,
            id: 'new-group',
            text: 'new group message',
            version: 1,
        });
        expect(groupResponse.status).toBe(200);

        const store = readConversationStore();
        expect(store.characters['nova.png']).toBeUndefined();
        expect(store.characters[unscopedGroupKey]).toBeUndefined();
        expect(store.legacyThreadPersonaAssignments).toEqual({});
        expect(store.characters[scopedSoloKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.id))
            .toEqual(['legacy-solo', 'scoped-solo', 'new-solo']);
        const scopedGroupKey = `persona:${encodeURIComponent(personaId)}:${unscopedGroupKey}`;
        expect(store.characters[scopedGroupKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.id))
            .toEqual(['legacy-group', 'new-group']);
    });

    test('group member aliases merge into one deterministic active anchor while disabled anchors remain', async () => {
        const personaId = 'riley.png';
        const groupId = 'canonical-group';
        const alphaKey = `persona:${personaId}:group:${groupId}:alpha.png`;
        const betaKey = `persona:${personaId}:group:${groupId}:beta.png`;
        const disabledKey = `persona:${personaId}:group:${groupId}:disabled.png`;
        const makeBranch = (id, messageId, unread, updatedAt) => ({
            id,
            messages: [{ id: messageId, role: 'user', mes: messageId, created_at: updatedAt }],
            unread,
            updatedAt,
        });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [{
                        id: groupId,
                        personaId,
                        members: ['alpha.png', 'beta.png', 'disabled.png'],
                        disabled_members: ['disabled.png'],
                    }],
                    reminders: [],
                    characters: {
                        [alphaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: makeBranch(DEFAULT_BRANCH_ID, 'alpha-main', 2, 100),
                                'alpha-branch': makeBranch('alpha-branch', 'alpha-branch-message', 4, 90),
                            },
                        },
                        [betaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: makeBranch(DEFAULT_BRANCH_ID, 'beta-main', 3, 200),
                                'beta-branch': makeBranch('beta-branch', 'beta-branch-message', 1, 180),
                            },
                        },
                        [disabledKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: makeBranch(DEFAULT_BRANCH_ID, 'disabled-main', 7, 300),
                            },
                        },
                    },
                },
            },
        }));

        const appendResponse = await postJson('/message/append', {
            avatar: 'alpha.png',
            groupId,
            personaId,
            id: 'new-group-message',
            text: 'ongoing canonical history',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);
        const appendJson = await appendResponse.json();
        expect(appendJson.threadKey).toBe(betaKey);

        const store = readConversationStore();
        expect(store.characters[alphaKey]).toBeUndefined();
        expect(store.characters[disabledKey].branches[DEFAULT_BRANCH_ID].messages[0].id).toBe('disabled-main');
        const canonical = store.characters[betaKey];
        expect(Object.keys(canonical.branches)).toEqual(expect.arrayContaining([
            DEFAULT_BRANCH_ID,
            'alpha-branch',
            'beta-branch',
        ]));
        expect(canonical.branches[DEFAULT_BRANCH_ID].messages.map(message => message.id))
            .toEqual(['alpha-main', 'beta-main', 'new-group-message']);
        expect(canonical.branches[DEFAULT_BRANCH_ID].unread).toBe(5);
        expect(canonical.branches['alpha-branch'].unread).toBe(4);
        expect(canonical.branches['beta-branch'].unread).toBe(1);

        const aliasReadResponse = await postJson('/thread/get', {
            avatar: 'alpha.png',
            groupId,
            personaId,
        });
        expect(aliasReadResponse.status).toBe(200);
        expect((await aliasReadResponse.json()).threadKey).toBe(betaKey);
    });

    test('group alias canonicalization retains overflow history in a deterministic merged branch', async () => {
        const groupId = 'overflow-group';
        const alphaKey = `group:${groupId}:alpha.png`;
        const betaKey = `group:${groupId}:beta.png`;
        const makeMessages = (prefix, offset) => Array.from({ length: 130 }, (_, index) => ({
            id: `${prefix}-${index}`,
            role: 'user',
            mes: `${prefix} ${index}`,
            created_at: offset + index,
        }));
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [{
                        id: groupId,
                        members: ['alpha.png', 'beta.png'],
                        disabled_members: [],
                    }],
                    reminders: [],
                    characters: {
                        [alphaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: makeMessages('alpha', 1),
                                    unread: 4,
                                    updatedAt: 100,
                                },
                            },
                        },
                        [betaKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: makeMessages('beta', 1000),
                                    unread: 6,
                                    updatedAt: 200,
                                },
                            },
                        },
                    },
                },
            },
        }));

        const response = await postJson('/message/append', {
            avatar: 'alpha.png',
            groupId,
            id: 'ongoing-message',
            text: 'continue after merge',
            version: 0,
        });
        expect(response.status).toBe(200);
        expect((await response.json()).threadKey).toBe(betaKey);

        const store = readConversationStore();
        expect(store.characters[alphaKey]).toBeUndefined();
        const canonical = store.characters[betaKey];
        const mergedBranchId = `${DEFAULT_BRANCH_ID}-merged-alpha.png`;
        expect(canonical.branches[DEFAULT_BRANCH_ID].messages).toHaveLength(131);
        expect(canonical.branches[DEFAULT_BRANCH_ID].unread).toBe(6);
        expect(canonical.branches[mergedBranchId].messages).toHaveLength(130);
        expect(canonical.branches[mergedBranchId].unread).toBe(4);
        expect(Object.values(canonical.branches).reduce((total, branch) => total + branch.messages.length, 0)).toBe(261);
    });

    test('message/append rejects stale settings versions', async () => {
        const response = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'stale write',
            version: 99,
        });

        expect(response.status).toBe(409);
        const json = await response.json();
        expect(json).toEqual({ error: 'settings_conflict', version: 0 });
        expect(readSettings()._version).toBe(0);
    });

    test('thread/save replaces a thread with normalized messages', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{
                role: 'user',
                name: 'Riley',
                mes: 'first saved message',
            }],
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(1);
        expect(json.messages).toHaveLength(1);
        expect(json.messages[0]).toMatchObject({
            role: 'user',
            name: 'Riley',
            mes: 'first saved message',
        });
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].preview).toBe('first saved message');
    });

    test('thread/save persists normalized aliases and generated message metadata', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{ text: 'message through text alias' }],
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.messages[0]).toMatchObject({
            role: 'user',
            name: 'User',
            mes: 'message through text alias',
            extra: {},
        });
        expect(json.messages[0].id).toEqual(expect.any(String));
        expect(json.messages[0].created_at).toEqual(expect.any(Number));
        expect(json.messages[0].send_date).toEqual(expect.any(String));
        expect(json.messages[0].text).toBeUndefined();
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages).toEqual(json.messages);
    });

    test('message IDs are selector-safe and unique within each thread', async () => {
        const duplicateThreadResponse = await postJson('/thread/save', {
            avatar: 'nova.png',
            version: 0,
            messages: [
                { id: 'duplicate-id', role: 'user', mes: 'first' },
                { id: 'duplicate-id', role: 'character', mes: 'second' },
            ],
        });
        expect(duplicateThreadResponse.status).toBe(400);
        await expect(duplicateThreadResponse.json()).resolves.toEqual({ error: 'duplicate_message_id' });

        const unsafeResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'unsafe"] .message',
            text: 'unsafe selector id',
            version: 0,
        });
        expect(unsafeResponse.status).toBe(400);
        await expect(unsafeResponse.json()).resolves.toEqual({ error: 'invalid_message_id' });

        const validResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'rest-message_123:reply.v1',
            text: 'safe id',
            version: 0,
        });
        expect(validResponse.status).toBe(200);
        const generatedIdResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'generated id',
            version: 1,
        });
        expect(generatedIdResponse.status).toBe(200);
        expect((await generatedIdResponse.json()).message.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

        const duplicateAppendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'rest-message_123:reply.v1',
            text: 'duplicate safe id',
            version: 2,
        });
        expect(duplicateAppendResponse.status).toBe(400);
        await expect(duplicateAppendResponse.json()).resolves.toEqual({ error: 'duplicate_message_id' });
        expect(readSettings()._version).toBe(2);
    });

    test('legacy unsafe and duplicate IDs and long message fields remain readable and repair on mutation', async () => {
        const unsafeId = 'legacy"] .message';
        const longName = 'N'.repeat(700);
        const longMessage = 'x'.repeat(300 * 1024);
        const legacyStore = {
            version: 1,
            settings: {},
            groups: [],
            reminders: [],
            characters: {
                'nova.png': {
                    activeBranchId: DEFAULT_BRANCH_ID,
                    branches: {
                        [DEFAULT_BRANCH_ID]: {
                            id: DEFAULT_BRANCH_ID,
                            messages: [
                                { id: unsafeId, role: 'user', name: longName, mes: longMessage, send_date: longName, created_at: 1 },
                                { id: 'legacy-1-0', role: 'character', name: 'Nova', mes: 'safe collision', created_at: 2 },
                                { id: 'duplicate-id', role: 'character', name: 'Nova', mes: 'first duplicate', created_at: 3 },
                                {
                                    id: 'duplicate-id',
                                    role: 'character',
                                    name: 'Nova',
                                    mes: 'second duplicate',
                                    created_at: 4,
                                    extra: { conversation_reply_to: { messageId: unsafeId, text: 'legacy reply' } },
                                },
                            ],
                        },
                    },
                },
            },
        };
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: { [CONVERSATION_STORE_KEY]: legacyStore },
        }));

        const readResponse = await postJson('/store/get', {});
        expect(readResponse.status).toBe(200);
        const readJson = await readResponse.json();
        expect(readJson.store.characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages[0]).toMatchObject({
            id: unsafeId,
            name: longName,
            mes: longMessage,
        });

        const strictReplacementResponse = await postJson('/store/save', { store: legacyStore, version: 0 });
        expect(strictReplacementResponse.status).toBe(400);
        await expect(strictReplacementResponse.json()).resolves.toMatchObject({ error: 'invalid_message_id' });

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'new-safe-id',
            text: 'new message',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);

        const messages = readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages;
        expect(messages[0].name).toBe(longName);
        expect(messages[0].mes).toBe(longMessage);
        expect(new Set(messages.map(message => message.id)).size).toBe(messages.length);
        expect(messages.every(message => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(message.id))).toBe(true);
        expect(messages[0].id).not.toBe('legacy-1-0');
        expect(messages[1].id).toBe('legacy-1-0');
        expect(messages[3].extra.conversation_reply_to.messageId).toBe(messages[0].id);

        const duplicateNewResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            id: 'duplicate-id',
            text: 'new duplicate',
            version: 1,
        });
        expect(duplicateNewResponse.status).toBe(400);
        await expect(duplicateNewResponse.json()).resolves.toEqual({ error: 'duplicate_message_id' });
        expect(readSettings()._version).toBe(1);
    });

    test('thread/save rejects invalid nested attachment entries', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{
                role: 'user',
                mes: 'invalid attachment metadata',
                extra: { media: ['https://example.com/image.png'] },
            }],
            version: 0,
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'invalid_stored_attachment' });
        expect(readSettings()._version).toBe(0);
    });

    test('thread/save retains browser-schema attachment-only messages', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: [{
                role: 'user',
                mes: '',
                extra: { media: [{ url: 'data:image/png;base64,YQ==', type: 'image' }] },
            }],
            version: 0,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.messages).toHaveLength(1);
        expect(json.messages[0].extra.media).toEqual([{ url: 'data:image/png;base64,YQ==', type: 'image' }]);
        expect(readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages).toHaveLength(1);
    });

    test('legacy attachment-only messages remain readable and migrate on mutation', async () => {
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [],
                    reminders: [],
                    characters: {
                        'nova.png': {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: [{
                                        id: 'legacy-attachment',
                                        role: 'user',
                                        mes: '',
                                        extra: {
                                            attachments: [
                                                { url: '/user/images/legacy.png', type: 'image', title: 'Legacy duplicate' },
                                                { url: '/user/files/legacy.txt', type: 'file', name: 'Legacy duplicate' },
                                            ],
                                            media: [{ url: '/user/images/legacy.png', type: 'image', title: 'Legacy' }],
                                            files: [{ url: '/user/files/legacy.txt', type: 'file', name: 'Legacy' }],
                                        },
                                    }],
                                },
                            },
                        },
                    },
                },
            },
        }, null, 4));

        const getResponse = await postJson('/store/get', {});
        expect(getResponse.status).toBe(200);
        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'after legacy attachment',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);

        const messages = readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages;
        expect(messages).toHaveLength(2);
        expect(messages[0].extra.attachments).toBeUndefined();
        expect(messages[0].extra.media).toEqual([{ url: '/user/images/legacy.png', type: 'image', title: 'Legacy' }]);
        expect(messages[0].extra.files).toEqual([{ url: '/user/files/legacy.txt', type: 'file', name: 'Legacy' }]);
    });

    test('message/send appends the user message, generates a reply, strips commands, and persists both messages', async () => {
        upstreamReplyText = '[selfie] Hello from Nova.';

        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'Can you say hi?',
            userName: 'Riley',
            version: 0,
            settings: {
                selfie_command_enabled: true,
                grounded_dialogue_rules_enabled: true,
                grounded_dialogue_rules: '### Grounded Dialogue Rules\n\n- Use concrete observable details instead of vague reactions.',
            },
            character: {
                data: {
                    name: 'Nova',
                    description: 'A friendly test character.',
                    personality: 'Warm and concise.',
                },
            },
            generation: {
                backend: 'chat',
                payload: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES,
                    reverse_proxy: upstreamUrl,
                    proxy_password: 'test-key',
                    model: 'gpt-5.4',
                    temperature: 1,
                    top_p: 1,
                    max_tokens: 64,
                },
            },
            includeGeneration: true,
            includePrompt: true,
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.version).toBe(1); // Atomic save: only one version increment
        expect(json.userMessage).toMatchObject({
            role: 'user',
            name: 'Riley',
            mes: 'Can you say hi?',
        });
        expect(json.replyMessage).toMatchObject({
            role: 'character',
            name: 'Nova',
            mes: 'Hello from Nova.',
        });
        expect(json.replyMessage.extra.conversation_reply_to).toMatchObject({
            messageId: json.userMessage.id,
            name: 'Riley',
            role: 'user',
            text: 'Can you say hi?',
        });
        expect(json.replyMessage.extra.conversation_commands.selfieRequests).toHaveLength(1);
        expect(json.generation.choices[0].message.content).toBe('[selfie] Hello from Nova.');
        expect(json.prompt.systemPrompt).toContain('You are Nova');
        expect(json.prompt.systemPrompt).toContain('Current system time context:');
        expect(json.prompt.systemPrompt).toContain('time of day, dates, timezones, reminders, scheduling');
        expect(json.prompt.systemPrompt).toContain('### Grounded Dialogue Rules');
        expect(json.prompt.systemPrompt).toContain('Use concrete observable details instead of vague reactions.');
        expect(json.prompt.messages.at(-1).content).toContain('Nova:');

        expect(upstreamRequests).toHaveLength(1);
        expect(upstreamRequests[0].model).toBe('gpt-5.4');
        expect(upstreamRequests[0].max_output_tokens).toBe(64);
        expect(upstreamRequests[0].instructions).toContain('You are Nova');
        expect(upstreamRequests[0].instructions).toContain('Current system time context:');
        expect(upstreamRequests[0].instructions).toContain('### Grounded Dialogue Rules');
        expect(JSON.stringify(upstreamRequests[0].input)).toContain('Can you say hi?');

        const settings = readSettings();
        expect(settings._version).toBe(1); // Atomic save: only one version increment
        const messages = settings.extension_settings[CONVERSATION_STORE_KEY]
            .characters['nova.png']
            .branches[DEFAULT_BRANCH_ID]
            .messages;
        expect(messages.map(message => message.mes)).toEqual(['Can you say hi?', 'Hello from Nova.']);
        expect(messages[1].extra.conversation_reply_to.messageId).toBe(messages[0].id);
    });

    test('message/send resolves authenticated relative user images without an HTTP loopback fetch', async () => {
        const albumPath = path.join(userDirectories.userImages, 'album');
        fs.mkdirSync(albumPath, { recursive: true });
        fs.writeFileSync(path.join(albumPath, 'photo.png'), Buffer.from('local image'));

        const saveResponse = await postJson('/thread/save', {
            avatar: 'nova.png',
            version: 0,
            messages: [{
                id: 'local-image-message',
                role: 'user',
                mes: '',
                extra: { media: [{ url: '/user/images/album/photo.png', type: 'image' }] },
            }],
        });
        expect(saveResponse.status).toBe(200);

        const sendResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'What is in my image?',
            version: 1,
            generation: getChatGeneration(),
        });
        expect(sendResponse.status).toBe(200);
        expect(JSON.stringify(upstreamRequests[0])).toContain('data:image/png;base64,');
    });

    test('message/send rejects oversized generated replies without persisting speculative messages', async () => {
        upstreamReplyText = 'x'.repeat(256 * 1024 + 1);
        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'Generate too much',
            version: 0,
            generation: getChatGeneration(),
        });
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toMatchObject({ error: 'generation_too_large' });
        expect(readSettings()._version).toBe(0);
        expect(readSettings().extension_settings[CONVERSATION_STORE_KEY]).toBeUndefined();
    });

    test('read and write routes reject corrupt or non-object settings without replacing them', async () => {
        const settingsPath = path.join(userDirectories.root, SETTINGS_FILE);
        fs.writeFileSync(settingsPath, '{not json');

        const readResponse = await postJson('/store/get', {});
        expect(readResponse.status).toBe(500);
        await expect(readResponse.json()).resolves.toEqual({ error: 'settings_read_failed' });

        const writeResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'must not persist',
            version: 0,
        });
        expect(writeResponse.status).toBe(500);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{not json');

        fs.writeFileSync(settingsPath, '[]');
        const nonObjectResponse = await postJson('/thread/get', { avatar: 'nova.png' });
        expect(nonObjectResponse.status).toBe(500);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe('[]');

        const invalidConversationSettings = JSON.stringify({
            _version: 0,
            extension_settings: { [CONVERSATION_STORE_KEY]: 'invalid' },
        });
        fs.writeFileSync(settingsPath, invalidConversationSettings);
        const invalidStoreResponse = await postJson('/store/get', {});
        expect(invalidStoreResponse.status).toBe(500);
        expect(fs.readFileSync(settingsPath, 'utf8')).toBe(invalidConversationSettings);
    });

    test('mutations refuse invalid nested stored shapes without overwriting them', async () => {
        const invalidStores = [
            { version: 1, characters: [], groups: [], reminders: [], settings: {} },
            { version: 1, characters: {}, groups: {}, reminders: [], settings: {} },
            {
                version: 1,
                characters: { 'nova.png': { activeBranchId: DEFAULT_BRANCH_ID, branches: [] } },
                groups: [],
                reminders: [],
                settings: {},
            },
            {
                version: 1,
                characters: {
                    'nova.png': {
                        activeBranchId: DEFAULT_BRANCH_ID,
                        branches: { [DEFAULT_BRANCH_ID]: { id: DEFAULT_BRANCH_ID, messages: {} } },
                    },
                },
                groups: [],
                reminders: [],
                settings: {},
            },
            {
                version: 1,
                characters: {
                    'nova.png': {
                        activeBranchId: DEFAULT_BRANCH_ID,
                        branches: { [DEFAULT_BRANCH_ID]: { id: DEFAULT_BRANCH_ID, messages: [null] } },
                    },
                },
                groups: [],
                reminders: [],
                settings: {},
            },
            {
                version: 1,
                characters: {
                    'nova.png': {
                        activeBranchId: DEFAULT_BRANCH_ID,
                        branches: {
                            [DEFAULT_BRANCH_ID]: {
                                id: DEFAULT_BRANCH_ID,
                                messages: [{ id: 'bad-attachment', role: 'user', mes: 'text', extra: { files: [null] } }],
                            },
                        },
                    },
                },
                groups: [],
                reminders: [],
                settings: {},
            },
        ];

        for (const store of invalidStores) {
            const serializedSettings = JSON.stringify({
                _version: 0,
                extension_settings: { [CONVERSATION_STORE_KEY]: store },
            });
            fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), serializedSettings);

            const response = await postJson('/message/append', {
                avatar: 'nova.png',
                text: 'must not overwrite corruption',
                version: 0,
            });
            expect(response.status).toBe(500);
            expect(fs.readFileSync(path.join(userDirectories.root, SETTINGS_FILE), 'utf8')).toBe(serializedSettings);
        }
    });

    test('missing settings are reported explicitly and can be initialized with version zero', async () => {
        fs.rmSync(path.join(userDirectories.root, SETTINGS_FILE));

        const readResponse = await postJson('/store/get', {});
        expect(readResponse.status).toBe(200);
        await expect(readResponse.json()).resolves.toMatchObject({ version: 0, settingsMissing: true });

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'first message',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);
        expect(readSettings()._version).toBe(1);
    });

    test('mutations require a valid expected settings version', async () => {
        const missingResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'missing version',
        });
        expect(missingResponse.status).toBe(400);
        await expect(missingResponse.json()).resolves.toEqual({ error: 'version_required' });

        const invalidResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'invalid version',
            version: '0',
        });
        expect(invalidResponse.status).toBe(400);
        await expect(invalidResponse.json()).resolves.toEqual({ error: 'invalid_version' });
    });

    test('storage keys retain raw syntax and reject colliding or reserved components', async () => {
        const rawKey = 'persona:riley!one.png:nova one% alt.png';
        const percentLiteralKey = 'persona:riley!one.png:alias%20name.png';
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), JSON.stringify({
            _version: 0,
            extension_settings: {
                [CONVERSATION_STORE_KEY]: {
                    version: 1,
                    settings: {},
                    groups: [],
                    reminders: [],
                    characters: {
                        [rawKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: [{ id: 'legacy-message', role: 'user', name: 'Riley', mes: 'legacy text' }],
                                },
                            },
                        },
                        [percentLiteralKey]: {
                            activeBranchId: DEFAULT_BRANCH_ID,
                            branches: {
                                [DEFAULT_BRANCH_ID]: {
                                    id: DEFAULT_BRANCH_ID,
                                    messages: [{ id: 'percent-literal', role: 'user', name: 'Riley', mes: 'literal percent owner' }],
                                },
                            },
                        },
                    },
                },
            },
        }, null, 4));

        const response = await postJson('/message/append', {
            avatar: 'nova one% alt.png',
            personaId: 'riley!one.png',
            text: 'new text',
            version: 0,
        });
        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.threadKey).toBe(rawKey);
        expect(readConversationStore().characters[rawKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes)).toEqual(['legacy text', 'new text']);

        const aliasResponse = await postJson('/message/append', {
            avatar: 'alias name.png',
            personaId: 'riley!one.png',
            text: 'space owner',
            version: 1,
        });
        expect(aliasResponse.status).toBe(200);
        expect((await aliasResponse.json()).threadKey).toBe('persona:riley!one.png:alias name.png');
        expect(readConversationStore().characters[percentLiteralKey].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes)).toEqual(['literal percent owner']);
        expect(readConversationStore().characters['persona:riley!one.png:alias name.png'].branches[DEFAULT_BRANCH_ID].messages.map(message => message.mes)).toEqual(['space owner']);

        const collidingAvatarResponse = await postJson('/message/append', {
            avatar: 'nova:one.png',
            text: 'blocked collision',
            version: 2,
        });
        expect(collidingAvatarResponse.status).toBe(400);
        await expect(collidingAvatarResponse.json()).resolves.toEqual({ error: 'invalid_avatar' });

        const collidingGroupResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: 'group:one',
            text: 'blocked group collision',
            version: 2,
        });
        expect(collidingGroupResponse.status).toBe(400);
        await expect(collidingGroupResponse.json()).resolves.toEqual({ error: 'invalid_group_id' });

        const reservedResponse = await postJson('/message/append', {
            avatar: '__proto__',
            text: 'blocked',
            version: 2,
        });
        expect(reservedResponse.status).toBe(400);

        const unsafeStore = JSON.parse('{"version":1,"localStorageMigrated":false,"settings":{},"characters":{"__proto__":{}},"groups":[],"reminders":[]}');
        const unsafeStoreResponse = await postJson('/store/save', { store: unsafeStore, version: 2 });
        expect(unsafeStoreResponse.status).toBe(400);
        await expect(unsafeStoreResponse.json()).resolves.toMatchObject({ error: 'unsafe_thread_key' });

        const unsafeBranchStore = {
            version: 1,
            localStorageMigrated: false,
            settings: {},
            characters: {
                'nova.png': {
                    activeBranchId: 'constructor',
                    branches: {
                        [DEFAULT_BRANCH_ID]: { id: DEFAULT_BRANCH_ID, messages: [] },
                    },
                },
            },
            groups: [],
            reminders: [],
        };
        const unsafeBranchResponse = await postJson('/store/save', { store: unsafeBranchStore, version: 2 });
        expect(unsafeBranchResponse.status).toBe(400);
        await expect(unsafeBranchResponse.json()).resolves.toMatchObject({ error: 'invalid_branch_id' });
        expect(Object.prototype.polluted).toBeUndefined();
    });

    test('thread/save rejects malformed stringified JSON', async () => {
        const response = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages: '[{"mes":',
            version: 0,
        });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: 'invalid_messages' });
        expect(readSettings()._version).toBe(0);
    });

    test('message/send rejects blank, role-injected, and invalid timestamp messages before generation', async () => {
        const invalidMessages = [
            { text: '   ', expected: 'message_required' },
            { text: 'role injection', role: 'system', expected: 'invalid_message_role' },
            { text: 'bad date', created_at: Number.MAX_SAFE_INTEGER, expected: 'invalid_created_at' },
        ];

        for (const invalidMessage of invalidMessages) {
            const response = await postJson('/message/send', {
                avatar: 'nova.png',
                version: 0,
                generation: getChatGeneration(),
                ...invalidMessage,
            });
            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toMatchObject({ error: invalidMessage.expected });
        }
        expect(upstreamRequests).toHaveLength(0);
        expect(readSettings()._version).toBe(0);
    });

    test('message/send accepts Object.prototype-named tool schema properties', async () => {
        const generation = getChatGeneration();
        const schemaProperties = JSON.parse('{"__proto__":{"type":"string"},"prototype":{"type":"string"}}');
        schemaProperties.constructor = { type: 'string' };
        schemaProperties.toString = { type: 'string' };
        generation.payload.tools = [{
            type: 'function',
            function: {
                name: 'schema_test',
                parameters: {
                    type: 'object',
                    properties: schemaProperties,
                },
            },
        }];

        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'tool schema names',
            version: 0,
            generation,
        });
        expect(response.status).toBe(200);
    });

    test('group mutations reject duplicate members and duplicate stored group IDs', async () => {
        const duplicateMembersResponse = await postJson('/group/create', {
            members: ['nova.png', ' nova.png ', 'echo.png'],
            version: 0,
        });
        expect(duplicateMembersResponse.status).toBe(400);
        await expect(duplicateMembersResponse.json()).resolves.toEqual({ error: 'duplicate_members' });

        const duplicateIdStore = {
            version: 1,
            settings: {},
            characters: {},
            groups: [
                { id: 'duplicate-group', members: ['nova.png', 'echo.png'] },
                { id: 'duplicate-group', members: ['nova.png', 'luna.png'] },
            ],
            reminders: [],
        };
        const duplicateIdResponse = await postJson('/store/save', { store: duplicateIdStore, version: 0 });
        expect(duplicateIdResponse.status).toBe(400);
        await expect(duplicateIdResponse.json()).resolves.toMatchObject({ error: 'duplicate_group_id' });

        const duplicateMemberStore = {
            ...duplicateIdStore,
            groups: [{ id: 'one-group', members: ['nova.png', ' nova.png ', 'echo.png'] }],
        };
        const duplicateStoreMembersResponse = await postJson('/store/save', { store: duplicateMemberStore, version: 0 });
        expect(duplicateStoreMembersResponse.status).toBe(400);
        await expect(duplicateStoreMembersResponse.json()).resolves.toMatchObject({ error: 'duplicate_group_members' });

        const duplicateDisabledMembersStore = {
            ...duplicateIdStore,
            groups: [{
                id: 'one-group',
                members: ['nova.png', 'echo.png'],
                disabled_members: ['nova.png', ' nova.png '],
            }],
        };
        const duplicateDisabledResponse = await postJson('/store/save', { store: duplicateDisabledMembersStore, version: 0 });
        expect(duplicateDisabledResponse.status).toBe(400);
        await expect(duplicateDisabledResponse.json()).resolves.toMatchObject({ error: 'duplicate_disabled_group_members' });

        const invalidDisabledMembersStore = {
            ...duplicateIdStore,
            groups: [{
                id: 'one-group',
                members: ['nova.png', 'echo.png'],
                disabled_members: [null],
            }],
        };
        const invalidDisabledResponse = await postJson('/store/save', { store: invalidDisabledMembersStore, version: 0 });
        expect(invalidDisabledResponse.status).toBe(400);
        await expect(invalidDisabledResponse.json()).resolves.toMatchObject({ error: 'invalid_disabled_group_members' });

        const nonMemberDisabledStore = {
            ...duplicateIdStore,
            groups: [{
                id: 'one-group',
                members: ['nova.png', 'echo.png'],
                disabled_members: ['luna.png'],
            }],
        };
        const nonMemberDisabledResponse = await postJson('/store/save', { store: nonMemberDisabledStore, version: 0 });
        expect(nonMemberDisabledResponse.status).toBe(400);
        await expect(nonMemberDisabledResponse.json()).resolves.toMatchObject({ error: 'invalid_disabled_group_members' });

        const duplicateSettings = JSON.stringify({
            _version: 0,
            extension_settings: { [CONVERSATION_STORE_KEY]: duplicateMemberStore },
        });
        fs.writeFileSync(path.join(userDirectories.root, SETTINGS_FILE), duplicateSettings);
        const mutationResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'must not normalize duplicates',
            version: 0,
        });
        expect(mutationResponse.status).toBe(500);
        expect(fs.readFileSync(path.join(userDirectories.root, SETTINGS_FILE), 'utf8')).toBe(duplicateSettings);
    });

    test('group validation rejects raw routing delimiters while allowing encoded persona delimiters', async () => {
        const invalidGroups = [
            { id: 'group:one', members: ['nova.png', 'echo.png'] },
            { id: 'group-one', members: ['nova:one.png', 'echo.png'] },
            { id: 'group-one', members: ['nova.png', 'echo.png'], disabled_members: ['nova:one.png'] },
        ];

        for (const group of invalidGroups) {
            const response = await postJson('/store/save', {
                version: 0,
                store: {
                    version: 1,
                    settings: {},
                    characters: {},
                    groups: [group],
                    reminders: [],
                },
            });
            expect(response.status).toBe(400);
        }

        const createResponse = await postJson('/group/create', {
            personaId: 'persona:one.png',
            members: ['nova.png', 'echo.png'],
            version: 0,
        });
        expect(createResponse.status).toBe(200);
        const json = await createResponse.json();
        expect(json.group.personaId).toBe('persona:one.png');
        expect(readSettings()._version).toBe(1);
    });

    test('message appends retain only the newest 250 messages', async () => {
        const messages = Array.from({ length: 250 }, (_, index) => ({
            id: `message-${index}`,
            role: 'user',
            name: 'Riley',
            mes: `message ${index}`,
        }));
        const saveResponse = await postJson('/thread/save', {
            avatar: 'nova.png',
            messages,
            version: 0,
        });
        expect(saveResponse.status).toBe(200);

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'message 250',
            version: 1,
        });
        expect(appendResponse.status).toBe(200);
        const json = await appendResponse.json();
        expect(json.messages).toHaveLength(250);
        expect(json.messages[0].mes).toBe('message 1');
        expect(json.messages.at(-1).mes).toBe('message 250');
    });

    test('group thread routes enforce the group persona and retain legacy roleplay group access', async () => {
        const createResponse = await postJson('/group/create', {
            personaId: 'riley.png',
            members: ['nova.png', 'echo.png'],
            version: 0,
        });
        const group = (await createResponse.json()).group;

        const unauthorizedRequests = [
            postJson('/thread/get', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png' }),
            postJson('/thread/save', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png', messages: [], version: 1 }),
            postJson('/message/append', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png', text: 'blocked', version: 1 }),
            postJson('/message/send', { avatar: 'nova.png', groupId: group.id, personaId: 'morgan.png', text: 'blocked', version: 1, generation: getChatGeneration() }),
        ];
        for (const pendingResponse of unauthorizedRequests) {
            const response = await pendingResponse;
            expect(response.status).toBe(400);
            await expect(response.json()).resolves.toEqual({ error: 'avatar_not_in_group' });
        }
        expect(upstreamRequests).toHaveLength(0);

        const legacyGroup = {
            id: 'legacy-roleplay-group',
            members: ['nova.png', 'echo.png'],
            disabled_members: [],
        };
        fs.writeFileSync(path.join(userDirectories.groups, `${legacyGroup.id}.json`), JSON.stringify(legacyGroup));
        const legacyResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            groupId: legacyGroup.id,
            text: 'legacy group message',
            version: 1,
        });
        expect(legacyResponse.status).toBe(200);
    });

    test('message/send preflights stale versions and detects a concurrent commit after generation', async () => {
        const staleResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'stale paid request',
            version: 7,
            generation: getChatGeneration(),
        });
        expect(staleResponse.status).toBe(409);
        expect(upstreamRequests).toHaveLength(0);

        upstreamResponseDelayMs = 100;
        const sendPromise = postJson('/message/send', {
            avatar: 'nova.png',
            text: 'concurrent generation',
            version: 0,
            generation: getChatGeneration(),
        });
        await waitForUpstreamRequests(1);

        const appendResponse = await postJson('/message/append', {
            avatar: 'nova.png',
            text: 'winning write',
            version: 0,
        });
        expect(appendResponse.status).toBe(200);

        const sendResponse = await sendPromise;
        expect(sendResponse.status).toBe(409);
        await expect(sendResponse.json()).resolves.toEqual({ error: 'settings_conflict', version: 1 });
        const persistedMessages = readConversationStore().characters['nova.png'].branches[DEFAULT_BRANCH_ID].messages;
        expect(persistedMessages.map(message => message.mes)).toEqual(['winning write']);
    });

    test('message/send supports the text completion backend adapter', async () => {
        upstreamReplyText = 'Text backend reply.';
        const response = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'Use text generation',
            version: 0,
            character: { name: 'Nova' },
            generation: {
                backend: 'text',
                payload: {
                    api_type: TEXTGEN_TYPES.GENERIC,
                    api_server: upstreamUrl,
                    max_tokens: 32,
                },
            },
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.replyMessage.mes).toBe('Text backend reply.');
        expect(upstreamRequests[0].prompt).toContain('Use text generation');
    });

    test('text completion validation still requires provider type and server', async () => {
        const missingTypeResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'missing type',
            version: 0,
            generation: { backend: 'text', payload: { api_server: upstreamUrl } },
        });
        expect(missingTypeResponse.status).toBe(400);
        await expect(missingTypeResponse.json()).resolves.toEqual({ error: 'generation_api_type_required' });

        const missingServerResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'missing server',
            version: 0,
            generation: { backend: 'text', payload: { api_type: TEXTGEN_TYPES.GENERIC } },
        });
        expect(missingServerResponse.status).toBe(400);
        await expect(missingServerResponse.json()).resolves.toEqual({ error: 'generation_api_server_required' });
        expect(upstreamRequests).toHaveLength(0);
    });

    test('message/send preserves safe upstream client statuses and maps upstream server failures to 502', async () => {
        upstreamResponseStatus = 429;
        const chatResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'chat rate limit',
            version: 0,
            generation: {
                backend: 'chat',
                payload: {
                    chat_completion_source: CHAT_COMPLETION_SOURCES.CUSTOM,
                    custom_url: upstreamUrl.replace(/\/$/, ''),
                    model: 'test-model',
                },
            },
        });
        expect(chatResponse.status).toBe(429);
        await expect(chatResponse.json()).resolves.toMatchObject({ error: 'generation_failed' });

        upstreamResponseStatus = 422;
        const textResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'text validation failure',
            version: 0,
            generation: {
                backend: 'text',
                payload: {
                    api_type: TEXTGEN_TYPES.GENERIC,
                    api_server: upstreamUrl,
                },
            },
        });
        expect(textResponse.status).toBe(422);

        upstreamResponseStatus = 503;
        const serverErrorResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'upstream unavailable',
            version: 0,
            generation: getChatGeneration(),
        });
        expect(serverErrorResponse.status).toBe(502);
        expect(readSettings()._version).toBe(0);
    });

    test('message/send charges validated requests per user and IP without spending user quota on invalid requests', async () => {
        for (let index = 0; index < 20; index++) {
            const invalidResponse = await postJson('/message/send', {
                avatar: 'nova.png',
                text: `invalid ${index}`,
                version: 0,
                generation: {
                    backend: 'chat',
                    payload: { chat_completion_source: CHAT_COMPLETION_SOURCES.OPENAI_RESPONSES },
                },
            });
            expect(invalidResponse.status).toBe(400);
        }

        const validResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'valid after pre-validation failures',
            version: 0,
            generation: getChatGeneration(),
        });
        expect(validResponse.status).toBe(200);

        upstreamResponseStatus = 422;
        for (let index = 0; index < 19; index++) {
            const rejectedUpstreamResponse = await postJson('/message/send', {
                avatar: 'nova.png',
                text: `validated failure ${index}`,
                version: 1,
                generation: getChatGeneration(),
            });
            expect(rejectedUpstreamResponse.status).toBe(422);
        }
        const limitedResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'same user is limited',
            version: 1,
            generation: getChatGeneration(),
        });
        expect(limitedResponse.status).toBe(429);

        userHandle = `${userHandle}-second-user`;
        upstreamResponseStatus = 200;
        const otherUserResponse = await postJson('/message/send', {
            avatar: 'nova.png',
            text: 'same IP, different authenticated user',
            version: 1,
            generation: getChatGeneration(),
        });
        expect(otherUserResponse.status).toBe(200);
    });
});
