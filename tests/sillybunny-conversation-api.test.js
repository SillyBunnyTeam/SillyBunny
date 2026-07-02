import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_COMPLETION_SOURCES, SETTINGS_FILE } from '../src/constants.js';
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
    const upstreamRequests = [];
    const tempDirs = [];

    beforeAll(async () => {
        const { router } = await import('../src/endpoints/sillybunny-conversation.js');

        upstreamServer = http.createServer(async (request, response) => {
            if (request.method !== 'POST' || request.url !== '/v1/responses') {
                response.writeHead(404);
                response.end();
                return;
            }

            const body = await readRequestJson(request);
            upstreamRequests.push(body);
            response.writeHead(200, { 'Content-Type': 'application/json' });
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
});
