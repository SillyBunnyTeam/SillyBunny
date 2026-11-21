/**
 * One chat of the audit character that is longer than the window the app renders at once (`power_user.chat_truncation`,
 * 100 messages by default), so that the "show more messages" control appears above the first rendered message. The turns
 * are plain, the user on even indexes and the character on odd ones. Like `chat-long` it is created over `/api/chats/save`
 * and does not change which chat the character opens. See `index.js` for the shape of a need module.
 */

import { fixture as character } from './character.js';
import { chatMessage, sentences } from '../need-kit.js';

const START = Date.UTC(2026, 0, 6, 9, 0, 0);
const USER = 'Audit User';

/** `count` messages after the header; `renderWindow` is the app's default window, and `hidden` how many messages start outside it. */
export const fixture = Object.freeze({
    file: 'audit-chat-very-long',
    userName: USER,
    count: 130,
    renderWindow: 100,
    hidden: 30,
});

function buildMessages() {
    return Array.from({ length: fixture.count }, (_, index) => {
        const user = index % 2 === 0;
        return chatMessage({
            name: user ? USER : character.name,
            user,
            index,
            start: START,
            text: `${index + 1}. ${sentences(1 + (index % 2), index)}`,
        });
    });
}

export default {
    requires: ['character'],
    async exists({ post }) {
        const response = await post('/api/chats/get', { data: { ch_name: character.name, file_name: fixture.file, avatar_url: character.avatar } }, { allow: [404, 500] });
        return response.ok() && (await response.json()).length > 0;
    },
    async seed({ post }) {
        const header = { user_name: USER, character_name: character.name, create_date: '2026-01-06@09h00m00s000ms', chat_metadata: {} };
        await post('/api/chats/save', { data: { ch_name: character.name, avatar_url: character.avatar, file_name: fixture.file, chat: [header, ...buildMessages()], force: true } });
        return `chat ${fixture.file}`;
    },
};
