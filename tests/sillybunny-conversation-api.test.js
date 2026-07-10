import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES, SETTINGS_FILE, TEXTGEN_TYPES } from '../src/constants.js';
import { setConfigFilePath } from '../src/util.js';
import { CONVERSATION_STORE_KEY, DEFAULT_BRANCH_ID } from '../public/scripts/sillybunny-conversation/constants.js';

setConfigFilePath(fileURLToPath(new URL('../default/config.yaml', import.meta.url)));

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
    const upstreamRequests = [];
    const tempDirs = [];

    beforeAll(async () => {
        const { router } = await import('../src/endpoints/sillybunny-conversation.js');

        upstreamServer = http.createServer(async (request, response) => {
            if (request.method !== 'POST' || !['/v1/responses', '/v1/completions'].includes(request.url)) {
                response.writeHead(404);
                response.end();
                return;
            }

            const body = await readRequestJson(request);
            upstreamRequests.push(body);
            if (upstreamResponseDelayMs) {
                await new Promise(resolve => setTimeout(resolve, upstreamResponseDelayMs));
            }
            response.writeHead(200, { 'Content-Type': 'application/json' });
            if (request.url === '/v1/completions') {
                response.end(JSON.stringify({ choices: [{ text: upstreamReplyText }] }));
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
        app.use(express.json());
        app.use((request, _response, next) => {
            request.user = { directories: userDirectories };
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
        upstreamRequests.length = 0;
        upstreamReplyText = 'Hello from Nova.';
        upstreamResponseDelayMs = 0;

        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-conversation-api-'));
        tempDirs.push(root);
        userDirectories = {
            root,
            backups: path.join(root, 'backups'),
            characters: path.join(root, 'characters'),
            groups: path.join(root, 'groups'),
        };
        fs.mkdirSync(userDirectories.backups, { recursive: true });
        fs.mkdirSync(userDirectories.characters, { recursive: true });
        fs.mkdirSync(userDirectories.groups, { recursive: true });
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
            members: ['alhaitham.png', 'kaveh.png'],
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
        expect(JSON.stringify(upstreamRequests[0])).toContain('Group DM reference context');
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

    test('store/save rejects colon-delimited persisted group routing components', async () => {
        const invalidGroups = [
            { id: 'group:one', members: ['nova.png', 'echo.png'] },
            { id: 'group-one', members: ['nova:one.png', 'echo.png'] },
            { id: 'group-one', members: ['nova.png', 'echo.png'], disabled_members: ['nova:one.png'] },
            { id: 'group-one', members: ['nova.png', 'echo.png'], personaId: 'persona:one.png' },
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
        expect(createResponse.status).toBe(400);
        await expect(createResponse.json()).resolves.toEqual({ error: 'invalid_persona_id' });
        expect(readSettings()._version).toBe(0);
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
                    model: 'test-model',
                    max_tokens: 32,
                },
            },
        });

        expect(response.status).toBe(200);
        const json = await response.json();
        expect(json.replyMessage.mes).toBe('Text backend reply.');
        expect(upstreamRequests[0].prompt).toContain('Use text generation');
    });
});
