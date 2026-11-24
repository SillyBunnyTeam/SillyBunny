import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { USER_DIRECTORY_TEMPLATE } from '../src/constants.js';
import { createSandboxUser, header, IMAGES, line, PERSONA } from './util/conversation-store-sandbox.js';

// The sandbox module sets the config file path, which these modules read when they load.
const { createConversation, readConversation, setConversationAvatar } = await import('../src/conversation-store.js');
const { DataMaidService } = await import('../src/endpoints/data-maid.js');

const CONVERSATION_ID = 'conv_1700000000000_abcdef0123';
const OTHER_CONVERSATION_ID = 'conv_1700000000001_abcdef0124';

let sandbox;
let directories;

beforeEach(() => {
    sandbox = createSandboxUser();
    directories = sandbox.user.directories;
    for (const [key, relative] of Object.entries(USER_DIRECTORY_TEMPLATE)) {
        directories[key] ??= path.join(sandbox.root, relative);
        fs.mkdirSync(directories[key], { recursive: true });
    }
});

afterEach(() => {
    sandbox.cleanup();
});

function store(relativePath) {
    const filePath = path.join(sandbox.root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'x');
    return filePath;
}

/** A message of a conversation chat, with the `extra` that the browser writes for an attachment. */
function messageWith(id, extra) {
    return { ...line(id, `text of ${id}`), extra };
}

function addConversation(id, kind, chats) {
    return createConversation(sandbox.user, {
        id,
        kind,
        personaId: PERSONA,
        characters: kind === 'group' ? ['Nova.png', 'Orion.png'] : ['Nova.png'],
        chats: chats.map(({ id: chatId, messages }) => ({ id: chatId, name: chatId, createdAt: 100, records: [header(), ...messages] })),
    }).conversation;
}

const relativeTo = base => paths => paths.map(item => path.relative(base, item).split(path.sep).join('/')).sort();

async function report() {
    const raw = await new DataMaidService('maid-conversations-test', directories).generateReport();
    return { images: relativeTo(directories.userImages)(raw.images), files: relativeTo(directories.files)(raw.files) };
}

describe('Data Maid and the chats of conversations', () => {
    test('an upload, a generated image and a file that a conversation chat names are in use, a file that nothing names is loose', async () => {
        store('user/images/Nova/uploaded.png');
        store('user/images/Nova/selfie.png');
        store('user/images/Nova/loose.png');
        store('user/files/notes.txt');
        store('user/files/loose.txt');
        addConversation(CONVERSATION_ID, 'direct', [{
            id: 'main',
            messages: [
                messageWith('m1', { media: [{ url: '/user/images/Nova/uploaded.png', type: 'image', source: 'upload' }] }),
                // A generated image is stored as `image_url`, and the path has no leading slash when the generator returns it so.
                messageWith('m2', { image_url: 'user/images/Nova/selfie.png', image_prompt: 'a selfie' }),
                messageWith('m3', { files: [{ url: '/user/files/notes.txt', size: 1, name: 'notes.txt' }] }),
            ],
        }]);

        expect(await report()).toEqual({ images: ['Nova/loose.png'], files: ['loose.txt'] });
    });

    test('every chat of a conversation and every conversation is read, not only the active chat', async () => {
        store('user/images/Nova/in-first-chat.png');
        store('user/images/Nova/in-second-chat.png');
        store('user/images/Nova/in-other-conversation.png');
        store('user/images/Nova/loose.png');
        addConversation(CONVERSATION_ID, 'group', [
            { id: 'main', messages: [messageWith('m1', { media: [{ url: '/user/images/Nova/in-first-chat.png' }] })] },
            { id: 'branch', messages: [messageWith('m2', { media: [{ url: '/user/images/Nova/in-second-chat.png' }] })] },
        ]);
        addConversation(OTHER_CONVERSATION_ID, 'direct', [
            { id: 'main', messages: [messageWith('m3', { media: [{ url: '/user/images/Nova/in-other-conversation.png' }] })] },
        ]);

        expect((await report()).images).toEqual(['Nova/loose.png']);
    });

    test('a roleplay chat and a conversation chat that name different files both keep their file', async () => {
        store('user/images/Nova/roleplay.png');
        store('user/images/Nova/conversation.png');
        store('user/images/Nova/loose.png');
        fs.mkdirSync(path.join(directories.chats, 'Nova'), { recursive: true });
        fs.writeFileSync(path.join(directories.chats, 'Nova', 'chat.jsonl'), [
            JSON.stringify(header()),
            JSON.stringify({ name: 'Nova', mes: 'hi', extra: { media: [{ url: '/user/images/Nova/roleplay.png' }] } }),
        ].join('\n'));
        addConversation(CONVERSATION_ID, 'direct', [
            { id: 'main', messages: [messageWith('m1', { media: [{ url: '/user/images/Nova/conversation.png' }] })] },
        ]);

        expect((await report()).images).toEqual(['Nova/loose.png']);
    });

    test('a remote or inline generated image names no file, and nothing is read from it', async () => {
        store('user/images/Nova/loose.png');
        addConversation(CONVERSATION_ID, 'direct', [{
            id: 'main',
            messages: [
                messageWith('m1', { image_url: 'https://example.com/user/images/Nova/loose.png' }),
                messageWith('m2', { image_url: 'data:image/png;base64,AAAA' }),
            ],
        }]);

        expect((await report()).images).toEqual(['Nova/loose.png']);
    });

    test('a chat file with a damaged line still keeps the files that its other lines name', async () => {
        store('user/images/Nova/kept.png');
        store('user/images/Nova/loose.png');
        addConversation(CONVERSATION_ID, 'direct', [
            { id: 'main', messages: [messageWith('m1', { media: [{ url: '/user/images/Nova/kept.png' }] })] },
        ]);
        fs.appendFileSync(path.join(directories.conversations, CONVERSATION_ID, 'chats', 'main.jsonl'), '\n{"id":"m2","extra":{"media":[{"url":');

        expect((await report()).images).toEqual(['Nova/loose.png']);
    });

    test('the group avatar sits in the conversation folder, which Data Maid never lists', async () => {
        addConversation(CONVERSATION_ID, 'group', [{ id: 'main', messages: [] }]);
        const { avatar } = setConversationAvatar(sandbox.user, CONVERSATION_ID, IMAGES.png);
        store('user/images/loose.png');

        const raw = await new DataMaidService('maid-conversations-test', directories).generateReport();
        const everything = Object.values(raw).flat();

        expect(readConversation(sandbox.user, CONVERSATION_ID).avatar).toBe(avatar);
        expect(everything.filter(item => item.startsWith(directories.conversations))).toEqual([]);
        expect(relativeTo(directories.userImages)(raw.images)).toEqual(['loose.png']);
    });

    test('a user without a conversations folder gets the same report as before', async () => {
        store('user/images/Nova/loose.png');
        fs.rmSync(directories.conversations, { recursive: true, force: true });
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

        expect((await report()).images).toEqual(['Nova/loose.png']);
        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });
});
