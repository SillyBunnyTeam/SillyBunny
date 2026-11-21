/**
 * One long chat of the audit character: 60 messages with the shapes a chat can show. See `index.js` for the shape of a
 * need module. Like the `chat` need it is created over `/api/chats/save`; it does not change which chat the character opens.
 */

import { fixture as character } from './character.js';
import { AVATAR_IMAGE_URL, chatMessage, sentences } from '../need-kit.js';

const START = Date.UTC(2026, 0, 2, 9, 0, 0);
const USER = 'Audit User';

/**
 * `file` is the chat file; `count` the number of messages after the header. The `*Index` values are indexes into the
 * messages (0 is the first). Turns alternate, the user on even indexes and the character on odd ones, so that the shapes
 * the app renders only on a character turn (reasoning, swipes, the last message's swipe controls) sit on odd indexes, and
 * the last message (59) is a character turn. The narrator message replaces the turn at its index.
 * `swipesIndex` is a swiped message in the middle; `lastSwipesIndex` is the last message, which shows the swipe controls.
 */
export const fixture = Object.freeze({
    file: 'audit-chat-long',
    userName: USER,
    count: 60,
    reasoningIndex: 11,
    swipesIndex: 21,
    lastSwipesIndex: 59,
    swipeCount: 3,
    narratorIndex: 30,
    codeIndex: 41,
    longIndex: 51,
    imageIndex: 57,
    longLength: 6000,
});

const CODE_MESSAGE = [
    'Here is the schedule as a table, and the script that prints it.',
    '',
    '| Day | Task | Hours |',
    '| --- | --- | ---: |',
    '| Monday | Lamp repair | 3 |',
    '| Tuesday | Ledger | 5 |',
    '| Wednesday | Map copying | 4 |',
    '',
    '```js',
    'const schedule = [["Monday", 3], ["Tuesday", 5], ["Wednesday", 4]];',
    'for (const [day, hours] of schedule) {',
    '    console.log(`${day}: ${hours} hours`);',
    '}',
    '```',
].join('\n');

function buildMessages() {
    return Array.from({ length: fixture.count }, (_, index) => {
        const user = index % 2 === 0;
        const name = user ? USER : character.name;
        const base = { name, user, index, start: START, text: `${index + 1}. ${sentences(2 + (index % 3), index)}` };
        switch (index) {
            case fixture.reasoningIndex:
                return chatMessage({
                    ...base,
                    text: 'After thinking it over, the lamp stays on the desk.',
                    extra: {
                        reasoning: `The question is where the lamp belongs.\n\n1. It lights the desk.\n2. It would block the window.\n\n${sentences(3, 5)}`,
                        reasoning_duration: 4200,
                        reasoning_type: 'model',
                    },
                });
            case fixture.swipesIndex:
            case fixture.lastSwipesIndex: {
                const swipes = [1, 2, 3].map(number => `Swipe ${number}. ${sentences(2, number * 4)}`);
                return chatMessage({
                    ...base,
                    text: swipes[1],
                    swipes,
                    swipe_id: 1,
                    swipe_info: swipes.map((_swipe, number) => ({ send_date: new Date(START + index * 60_000 + number * 1000).toISOString(), extra: {} })),
                });
            }
            case fixture.narratorIndex:
                return chatMessage({
                    ...base,
                    name: 'Narrator',
                    user: false,
                    text: 'The lamp flickers, and the room grows quiet.',
                    is_system: true,
                    extra: { type: 'narrator' },
                });
            case fixture.codeIndex:
                return chatMessage({ ...base, text: CODE_MESSAGE });
            case fixture.longIndex:
                return chatMessage({ ...base, text: sentences(120, 9).slice(0, fixture.longLength) });
            case fixture.imageIndex:
                return chatMessage({
                    ...base,
                    text: '',
                    extra: { media: [{ url: AVATAR_IMAGE_URL, type: 'image', title: 'Audit image', source: 'api' }], inline_image: false },
                });
            default:
                return chatMessage(base);
        }
    });
}

export default {
    requires: ['character'],
    async exists({ post }) {
        const response = await post('/api/chats/get', { data: { ch_name: character.name, file_name: fixture.file, avatar_url: character.avatar } }, { allow: [404, 500] });
        return response.ok() && (await response.json()).length > 0;
    },
    async seed({ post }) {
        const header = { user_name: USER, character_name: character.name, create_date: '2026-01-02@09h00m00s000ms', chat_metadata: {} };
        await post('/api/chats/save', { data: { ch_name: character.name, avatar_url: character.avatar, file_name: fixture.file, chat: [header, ...buildMessages()], force: true } });
        return `chat ${fixture.file}`;
    },
};
