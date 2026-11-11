/**
 * A group of three members (the audit character and the first two of `characters-many`) with its chat file named in
 * advance, so that `group-chat` can fill it. See `index.js` for the shape of a need module.
 */

import { fixture as character } from './character.js';
import { fixture as many } from './characters-many.js';

export const fixture = Object.freeze({
    name: 'Audit Group',
    chatId: 'audit-group-chat',
    members: Object.freeze([character.avatar, many.characters[0].avatar, many.characters[1].avatar]),
});

export default {
    requires: ['character', 'characters-many'],
    async exists({ post }) {
        const groups = await (await post('/api/groups/all', { data: {} })).json();
        return groups.some(group => group.name === fixture.name);
    },
    async seed({ post }) {
        await post('/api/groups/create', {
            data: {
                name: fixture.name, members: [...fixture.members], avatar_url: '', allow_self_responses: false, activation_strategy: 0,
                generation_mode: 0, chat_id: fixture.chatId, chats: [fixture.chatId],
            },
        });
        return `group ${fixture.name}`;
    },
};
