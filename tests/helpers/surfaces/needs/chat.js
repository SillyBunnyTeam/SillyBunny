/** A saved chat of the audit character, and the character's pointer to it. See `index.js` for the shape of a need module. */

import { fixture as character } from './character.js';

const SEND_DATE = Date.UTC(2026, 0, 1, 12, 0, 0);

export const fixture = Object.freeze({
    file: 'audit-chat',
    userName: 'Audit User',
    messages: Object.freeze([
        'Hello. This is the audit fixture.',
        'Can you describe the room?',
        'A quiet room with a lamp, a desk and a window.',
        'Thank you.',
    ]),
});

export default {
    requires: ['character'],
    async exists({ post }) {
        const response = await post('/api/chats/get', { data: { ch_name: character.name, file_name: fixture.file, avatar_url: character.avatar } }, { allow: [404, 500] });
        return response.ok() && (await response.json()).length > 0;
    },
    async seed({ post }) {
        const header = { user_name: fixture.userName, character_name: character.name, create_date: '2026-01-01@12h00m00s000ms', chat_metadata: {} };
        const messages = fixture.messages.map((text, index) => ({
            name: index % 2 === 0 ? character.name : fixture.userName,
            is_user: index % 2 === 1,
            is_system: false,
            send_date: new Date(SEND_DATE + index * 60_000).toISOString(),
            mes: text,
            extra: {},
        }));
        await post('/api/chats/save', { data: { ch_name: character.name, avatar_url: character.avatar, file_name: fixture.file, chat: [header, ...messages], force: true } });
        // The app opens the chat that the character points at.
        await post('/api/characters/edit-attribute', { data: { avatar_url: character.avatar, ch_name: character.name, field: 'chat', value: fixture.file } });
        return `chat ${fixture.file}`;
    },
};
