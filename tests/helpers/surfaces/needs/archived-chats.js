/**
 * Five chats across two characters, which the Chats Archive lists (it reads the character chat folders): three of the audit
 * character and two of the first character of `characters-many`. Created over `/api/chats/save`.
 * See `index.js` for the shape of a need module.
 */

import { fixture as character } from './character.js';
import { fixture as many } from './characters-many.js';
import { chatMessage, sentences } from '../need-kit.js';

const START = Date.UTC(2026, 0, 4, 8, 0, 0);
const USER = 'Audit User';
const second = many.characters[0];

/** `chats` lists the chat file, the avatar and name of its character, and the number of messages. */
export const fixture = Object.freeze({
    chats: Object.freeze([
        { file: 'audit-archive-1', avatar: character.avatar, name: character.name, messages: 3 },
        { file: 'audit-archive-2', avatar: character.avatar, name: character.name, messages: 5 },
        { file: 'audit-archive-3', avatar: character.avatar, name: character.name, messages: 2 },
        { file: 'audit-archive-4', avatar: second.avatar, name: second.name, messages: 4 },
        { file: 'audit-archive-5', avatar: second.avatar, name: second.name, messages: 6 },
    ].map(chat => Object.freeze(chat))),
});

async function hasChat(post, chat) {
    const response = await post('/api/chats/get', { data: { ch_name: chat.name, file_name: chat.file, avatar_url: chat.avatar } }, { allow: [404, 500] });
    return response.ok() && (await response.json()).length > 0;
}

export default {
    requires: ['character', 'characters-many'],
    async exists({ post }) {
        const present = await Promise.all(fixture.chats.map(chat => hasChat(post, chat)));
        return present.every(Boolean);
    },
    async seed({ post }) {
        let created = 0;
        for (const [number, chat] of fixture.chats.entries()) {
            if (await hasChat(post, chat)) {
                continue;
            }
            const start = START + number * 3_600_000;
            const header = { user_name: USER, character_name: chat.name, create_date: '2026-01-04@08h00m00s000ms', chat_metadata: {} };
            const messages = Array.from({ length: chat.messages }, (_, index) => chatMessage({
                name: index % 2 === 0 ? chat.name : USER, user: index % 2 === 1, index, start,
                text: index === 0 ? `Archived chat ${number + 1} of ${chat.name}.` : sentences(2, number + index),
            }));
            await post('/api/chats/save', { data: { ch_name: chat.name, avatar_url: chat.avatar, file_name: chat.file, chat: [header, ...messages], force: true } });
            created++;
        }
        return `${created} archived chats`;
    },
};
