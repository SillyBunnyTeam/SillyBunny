/** The chat of the `group` need, with messages from its three members and the user. See `index.js` for the shape of a need module. */

import { fixture as group } from './group.js';
import { fixture as many } from './characters-many.js';
import { fixture as character } from './character.js';
import { chatMessage, sentences } from '../need-kit.js';

const START = Date.UTC(2026, 0, 3, 18, 0, 0);
const USER = 'Audit User';

/** `turns` lists the speaker of each message after the header, in order; a member is named by its avatar. */
export const fixture = Object.freeze({
    chatId: group.chatId,
    userName: USER,
    turns: Object.freeze([
        { speaker: null, text: 'Good evening, everyone.' },
        { speaker: character.avatar, text: 'Good evening. The lamp is lit.' },
        { speaker: many.characters[0].avatar, text: `Then we can begin. ${sentences(2, 3)}` },
        { speaker: many.characters[1].avatar, text: `I brought the maps. ${sentences(1, 8)}` },
        { speaker: null, text: 'Let us start with the harbour.' },
        { speaker: character.avatar, text: `The harbour is quiet tonight. ${sentences(2, 12)}` },
    ]),
});

const nameOf = avatar => (avatar === character.avatar ? character.name : many.characters.find(entry => entry.avatar === avatar).name);

export default {
    requires: ['group'],
    async exists({ post }) {
        const response = await post('/api/chats/group/get', { data: { id: fixture.chatId } }, { allow: [404, 500] });
        return response.ok() && (await response.json()).length > 1;
    },
    async seed({ post }) {
        const header = { chat_metadata: {}, user_name: USER, character_name: 'unused', create_date: '2026-01-03@18h00m00s000ms' };
        const messages = fixture.turns.map((turn, index) => chatMessage({
            name: turn.speaker ? nameOf(turn.speaker) : USER,
            user: turn.speaker === null,
            text: turn.text,
            index,
            start: START,
            ...(turn.speaker && { original_avatar: turn.speaker }),
        }));
        await post('/api/chats/group/save', { data: { id: fixture.chatId, chat: [header, ...messages], force: true } });
        return `group chat ${fixture.chatId}`;
    },
};
