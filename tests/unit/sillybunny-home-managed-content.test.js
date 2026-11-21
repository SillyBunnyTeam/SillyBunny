/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions and a request client. */
import { describe, expect, jest, test } from '@jest/globals';
import {
    DISMISSED_KEY,
    NO_OFFERS,
    ManagedContentRequestError,
    createManagedContentClient,
    describeOffers,
    findOffers,
    parseDismissed,
    parseManagedStatus,
    serializeDismissed,
    withKeptVersion,
} from '../../public/scripts/sillybunny-home/managed-content.js';

const REISEN = 'default_AssistantReisen.png';

/** One entry of the status, as the route answers with it. */
const entry = (overrides = {}) => ({ filename: REISEN, type: 'character', version: 2, status: 'modified', updateAvailable: true, ...overrides });
const offersFor = ({ cardState = 'available', items = [entry()], dismissed = new Map(), filename = REISEN } = {}) => findOffers({ filename, cardState, items, dismissed });

describe('the account storage key of the kept versions', () => {
    test('is the one that the contract names', () => {
        expect(DISMISSED_KEY).toBe('WelcomePage_ManagedDismissed');
    });
});

describe('reading the status', () => {
    test('keeps the entries of the three types with their status and whether an update is available', () => {
        const body = { items: [entry(), entry({ filename: 'Assistant Reisen', type: 'sprites', status: 'current', updateAvailable: false }), entry({ filename: 'Lexicon.json', type: 'world' })] };

        expect(parseManagedStatus(body).map(({ filename, type, status }) => [filename, type, status])).toEqual([
            [REISEN, 'character', 'modified'],
            ['Assistant Reisen', 'sprites', 'current'],
            ['Lexicon.json', 'world', 'modified'],
        ]);
    });

    test('takes an update as available only when the server said true', () => {
        const [item] = parseManagedStatus({ items: [entry({ updateAvailable: 'yes' })] });

        expect(item.updateAvailable).toBe(false);
    });

    test.each([
        ['an entry without a filename', entry({ filename: '' })],
        ['an entry of a type that is not known', entry({ type: 'preset' })],
        ['an entry whose version is not a number', entry({ version: '2' })],
        ['an entry whose version is not finite', entry({ version: Number.POSITIVE_INFINITY })],
        ['an entry without a status', entry({ status: undefined })],
        ['a value that is not an entry', 'default_AssistantReisen.png'],
        ['nothing', null],
    ])('leaves out %s and keeps the entries around it', (_case, bad) => {
        const parsed = parseManagedStatus({ items: [entry({ filename: 'first.png' }), bad, entry({ filename: 'last.png' })] });

        expect(parsed.map(item => item.filename)).toEqual(['first.png', 'last.png']);
    });

    test.each([null, undefined, 'status', 3, [], {}, { items: 'none' }])('finds no entries in %p', (body) => {
        expect(parseManagedStatus(body)).toEqual([]);
    });
});

describe('the kept versions', () => {
    test('are read from the stored JSON text, by filename', () => {
        const kept = parseDismissed(JSON.stringify({ [REISEN]: 2, 'default_AssistantTewi.png': 5 }));

        expect([...kept]).toEqual([[REISEN, 2], ['default_AssistantTewi.png', 5]]);
    });

    test('are none when nothing was stored', () => {
        expect(parseDismissed(null).size).toBe(0);
        expect(parseDismissed(undefined).size).toBe(0);
    });

    test.each([
        ['text that is not JSON', '{not json'],
        ['a list', '[1,2]'],
        ['a number', '4'],
        ['null', 'null'],
    ])('are none for %s, so a damaged value brings the prompt back instead of hiding it', (_case, stored) => {
        expect(parseDismissed(stored).size).toBe(0);
    });

    test('leave out a version that is not a finite number and keep the others', () => {
        const kept = parseDismissed(JSON.stringify({ a: 1, b: '2', c: null, d: 3 }));

        expect([...kept]).toEqual([['a', 1], ['d', 3]]);
    });

    test('hold a name like __proto__ as an entry, and do not change what other maps inherit', () => {
        const kept = parseDismissed('{"__proto__": 9}');

        expect(kept.get('__proto__')).toBe(9);
        expect({}.polluted).toBeUndefined();
        expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    });

    test('are written as a record of filename to version, and read back as they were', () => {
        const kept = new Map([[REISEN, 2], ['x.png', 1]]);

        expect(JSON.parse(serializeDismissed(kept))).toEqual({ [REISEN]: 2, 'x.png': 1 });
        expect([...parseDismissed(serializeDismissed(kept))]).toEqual([...kept]);
    });

    test('gain a version for a file without changing the map they came from', () => {
        const kept = new Map([['x.png', 1]]);

        const next = withKeptVersion(kept, REISEN, 2);

        expect([...next]).toEqual([['x.png', 1], [REISEN, 2]]);
        expect([...kept]).toEqual([['x.png', 1]]);
    });

    test('never go down, so keeping an older version later does not bring back the prompt for a newer one', () => {
        const kept = new Map([[REISEN, 4]]);

        expect(withKeptVersion(kept, REISEN, 3).get(REISEN)).toBe(4);
        expect(withKeptVersion(kept, REISEN, 5).get(REISEN)).toBe(5);
    });
});

describe('what a card offers', () => {
    describe('Restore', () => {
        test('is offered for a deleted card whose bundled file the server reports as deleted', () => {
            expect(offersFor({ cardState: 'deleted', items: [entry({ status: 'deleted', updateAvailable: false })] }))
                .toEqual({ filename: REISEN, restore: true, update: null });
        });

        test.each(['current', 'updated', 'modified', 'not-installed'])('is not offered for a deleted card whose file the server reports as %s', (status) => {
            expect(offersFor({ cardState: 'deleted', items: [entry({ status })] })).toBe(NO_OFFERS);
        });

        test('is offered for a card that has no file and was never deleted in SillyBunny, when the server reports the file as deleted', () => {
            expect(offersFor({ cardState: 'missing', items: [entry({ status: 'deleted', updateAvailable: false })] }))
                .toEqual({ filename: REISEN, restore: true, update: null });
        });

        test.each(['current', 'updated', 'modified', 'not-installed'])('is not offered for a missing card whose file the server reports as %s', (status) => {
            expect(offersFor({ cardState: 'missing', items: [entry({ status })] })).toBe(NO_OFFERS);
        });

        test('is not offered for a card that has its file, even when the server reports the bundled file as deleted', () => {
            expect(offersFor({ cardState: 'available', items: [entry({ status: 'deleted', updateAvailable: false })] })).toBe(NO_OFFERS);
        });
    });

    describe('Update Available', () => {
        test('is offered for an edited card when the bundled version is newer and nothing was kept', () => {
            expect(offersFor()).toEqual({ filename: REISEN, restore: false, update: { version: 2 } });
        });

        test.each(['current', 'updated', 'deleted', 'not-installed'])('is not offered when the server reports the file as %s', (status) => {
            expect(offersFor({ items: [entry({ status })] })).toBe(NO_OFFERS);
        });

        test('is not offered when the server says that no update is available', () => {
            expect(offersFor({ items: [entry({ updateAvailable: false })] })).toBe(NO_OFFERS);
        });

        test.each(['deleted', 'missing'])('is not offered for a card that is %s, which has no card to update', (cardState) => {
            expect(offersFor({ cardState })).toBe(NO_OFFERS);
        });

        test('is not offered for the version that the user kept their card against', () => {
            expect(offersFor({ dismissed: new Map([[REISEN, 2]]) })).toBe(NO_OFFERS);
        });

        test('is not offered for a version older than the one that was kept', () => {
            expect(offersFor({ dismissed: new Map([[REISEN, 3]]) })).toBe(NO_OFFERS);
        });

        test('comes back for a bundled version newer than the one that was kept', () => {
            expect(offersFor({ items: [entry({ version: 3 })], dismissed: new Map([[REISEN, 2]]) }).update).toEqual({ version: 3 });
        });

        test('is not held back by a version kept for another file', () => {
            expect(offersFor({ dismissed: new Map([['default_AssistantTewi.png', 9]]) }).update).toEqual({ version: 2 });
        });
    });

    describe('what has no offers', () => {
        test.each(['sprites', 'world'])('is a %s entry that was modified, which stays silent', (type) => {
            expect(offersFor({ items: [entry({ type })] })).toBe(NO_OFFERS);
        });

        test.each(['sprites', 'world'])('is a deleted %s entry, because only a card is restored from Home', (type) => {
            expect(offersFor({ cardState: 'deleted', items: [entry({ type, status: 'deleted' })] })).toBe(NO_OFFERS);
        });

        test('is a file that the status does not list', () => {
            expect(offersFor({ filename: 'other.png' })).toBe(NO_OFFERS);
        });

        test.each([[null], [[]]])('is any card while the status is %p', (items) => {
            expect(offersFor({ items })).toBe(NO_OFFERS);
        });

        test('is shared and frozen, so a card cannot change what every other card offers', () => {
            expect(Object.isFrozen(NO_OFFERS)).toBe(true);
            expect(NO_OFFERS).toEqual({ filename: null, restore: false, update: null });
        });
    });
});

describe('what a status can make Home offer', () => {
    test('is a restore for a character whose bundled file is deleted, and an update for an edited one that is behind', () => {
        const items = [entry({ filename: 'gone.png', status: 'deleted', updateAvailable: false }), entry({ filename: 'edited.png', version: 4 })];

        expect(describeOffers(items)).toEqual([['gone.png', null, true], ['edited.png', 4, false]]);
    });

    test.each([
        ['no status is known', null],
        ['the status has no entries', []],
        ['every file needs nothing', [entry({ status: 'current', updateAvailable: false }), entry({ filename: 'b.png', status: 'not-installed', updateAvailable: false })]],
        ['an unedited card is behind, which the server updates itself', [entry({ status: 'updated' })]],
        ['an edited card has no newer version', [entry({ updateAvailable: false })]],
        ['a sprite folder or a world is edited or deleted', [entry({ type: 'sprites' }), entry({ type: 'world', status: 'deleted' })]],
    ])('is nothing when %s', (_case, items) => {
        expect(describeOffers(items)).toEqual([]);
    });

    test('does not read the kept versions, because a read of the status never changes them', () => {
        expect(describeOffers([entry({ version: 2 })])).toEqual([[REISEN, 2, false]]);
    });
});

describe('the requests', () => {
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' };
    const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: jest.fn(async () => body) });
    const create = send => createManagedContentClient({ fetch: send, getHeaders: () => headers });

    test('read the status with GET and the headers of the app, and parse it', async () => {
        const send = jest.fn(async () => reply({ items: [entry(), { nonsense: true }] }));
        const signal = new AbortController().signal;

        const items = await create(send).loadStatus({ signal });

        expect(send).toHaveBeenCalledWith('/api/sillybunny/managed-content/status', { method: 'GET', headers, signal });
        expect(items.map(item => item.filename)).toEqual([REISEN]);
    });

    test.each([['apply'], ['restore']])('%s posts the filename as JSON to its own route', async (action) => {
        const send = jest.fn(async () => reply({ backup: 'x' }));

        const answer = await create(send)[action](REISEN);

        expect(send).toHaveBeenCalledWith(`/api/sillybunny/managed-content/${action}`, { method: 'POST', headers, body: JSON.stringify({ filename: REISEN }) });
        expect(answer).toEqual({ backup: 'x' });
    });

    test('refuse with the status and the code that the server gave', async () => {
        const send = jest.fn(async () => reply({ error: 'already_current' }, { ok: false, status: 409 }));

        const failure = await create(send).apply(REISEN).catch(error => error);

        expect(failure).toBeInstanceOf(ManagedContentRequestError);
        expect(failure).toMatchObject({ httpStatus: 409, code: 'already_current' });
    });

    test('refuse with no code when the refusal has no JSON body or no code in it', async () => {
        const noBody = { ok: false, status: 502, json: jest.fn(async () => { throw new SyntaxError('no body'); }) };
        const noCode = reply({ error: { nested: true } }, { ok: false, status: 500 });

        const first = await create(jest.fn(async () => noBody)).restore(REISEN).catch(error => error);
        const second = await create(jest.fn(async () => noCode)).restore(REISEN).catch(error => error);

        expect(first).toMatchObject({ httpStatus: 502, code: null });
        expect(second).toMatchObject({ httpStatus: 500, code: null });
    });

    test('let a network failure reach the caller', async () => {
        const send = jest.fn(async () => { throw new TypeError('network'); });

        await expect(create(send).loadStatus()).rejects.toThrow('network');
    });

    test('read the headers of every request, not once when the client is made', async () => {
        const getHeaders = jest.fn(() => headers);
        const send = jest.fn(async () => reply({ items: [] }));
        const client = createManagedContentClient({ fetch: send, getHeaders });

        await client.loadStatus();
        await client.loadStatus();

        expect(getHeaders).toHaveBeenCalledTimes(2);
    });
});
