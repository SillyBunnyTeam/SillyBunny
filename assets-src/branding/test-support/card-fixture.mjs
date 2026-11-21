/**
 * A V3 card shaped like the assistant cards (root fields mirrored in `data`, extensions with a depth prompt), with made-up text. It has CRLF
 * line breaks, quotes, non-ASCII characters and empty lists, which are what a card's text is likely to break a writer on. `world` is empty,
 * as in the cards the user writes.
 * @param {{ name?: string, book?: boolean, world?: string }} [options]
 */
export function fixtureCard({ name = 'Fixture Bun', book = false, world = '' } = {}) {
    const description = '{{char}} is a test rabbit.\r\n\r\n<Example_Responses>\r\n{{user}}: Hello?\r\n{{char}}: "Hi, é — ü ☆ 🐇."\r\n</Example_Responses>';
    const creatorNotes = 'Made for the tests. Not real text.';
    const tags = ['Test', 'Fixture, with a comma'];
    const card = {
        name,
        description,
        personality: '',
        scenario: 'A test scenario with "quotes" and a \\ backslash.',
        first_mes: '"Hello, {{user}}." *waves*\r\nSecond line.',
        mes_example: '',
        creatorcomment: creatorNotes,
        avatar: 'none',
        talkativeness: '0.35',
        fav: false,
        tags,
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name,
            description,
            personality: '',
            scenario: 'A test scenario with "quotes" and a \\ backslash.',
            first_mes: '"Hello, {{user}}." *waves*\r\nSecond line.',
            mes_example: '',
            creator_notes: creatorNotes,
            system_prompt: '# Role\r\n\r\nPortray {{char}}.',
            post_history_instructions: '',
            tags,
            creator: 'Nobody',
            character_version: '1.0',
            alternate_greetings: [],
            nickname: 'Bun',
            group_only_greetings: [],
            extensions: {
                talkativeness: '0.35',
                fav: false,
                world,
                depth_prompt: { prompt: '[ Tags: test ;\r\n\r\nSetting: nowhere ]', depth: 4, role: 'system' },
            },
            ...(book ? { character_book: { name: 'Embedded', entries: [{ keys: ['k'], content: 'c', enabled: true, insertion_order: 0, extensions: {} }], extensions: {} } } : {}),
        },
        create_date: '2026-10-31T20:00:34.483Z',
    };
    return card;
}
