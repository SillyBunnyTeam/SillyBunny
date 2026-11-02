/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a status holder. */
import { describe, expect, jest, test } from '@jest/globals';
import { createManagedStatus } from '../../public/scripts/sillybunny-home/managed-status.js';

const item = (filename, overrides = {}) => ({ filename, type: 'character', version: 2, status: 'modified', updateAvailable: true, ...overrides });

/** A read that the test answers itself, so it decides in which order two reads finish. */
function createGate() {
    const gate = {};
    gate.promise = new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
    return gate;
}

function create(loadStatus, options = {}) {
    return createManagedStatus({ loadStatus, firstMountWaitMs: 300, requestTimeoutMs: 5000, delay: () => new Promise(() => {}), ...options });
}

describe('reading the status', () => {
    test('has nothing known before the first answer', () => {
        expect(create(jest.fn()).read()).toBeNull();
    });

    test('keeps the answer and hands it to the next render', async () => {
        const status = create(jest.fn(async () => [item('a.png')]));

        await status.refresh();

        expect(status.read()).toEqual([item('a.png')]);
    });

    test('asks for a read that ends on its own, with the timeout it was given', async () => {
        const loadStatus = jest.fn(async () => []);

        await create(loadStatus, { requestTimeoutMs: 1234 }).refresh();

        const [{ signal }] = loadStatus.mock.calls[0];
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
    });

    test('gives up a read that takes longer than the timeout it was given, and knows nothing then', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const hung = ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); });
        const status = create(hung, { requestTimeoutMs: 20 });

        await status.refresh();

        expect(status.read()).toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('never rejects, and knows nothing when the first read fails', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const status = create(jest.fn(async () => { throw new TypeError('network'); }));

        await expect(status.refresh()).resolves.toBeUndefined();

        expect(status.read()).toBeNull();
        warn.mockRestore();
    });

    test('keeps the last known answer when a later read fails, so the offers do not flicker away', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const loadStatus = jest.fn()
            .mockResolvedValueOnce([item('a.png')])
            .mockRejectedValueOnce(new Error('down'));
        const status = create(loadStatus);
        await status.refresh();

        await status.refresh();

        expect(status.read()).toEqual([item('a.png')]);
        warn.mockRestore();
    });
});

describe('two reads that overlap', () => {
    test('keep the answer of the newer read when the older one lands last', async () => {
        const older = createGate();
        const newer = createGate();
        const status = create(jest.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise));

        const first = status.refresh();
        const second = status.refresh();
        newer.resolve([item('new.png')]);
        await second;
        older.resolve([item('old.png')]);
        await first;

        expect(status.read()).toEqual([item('new.png')]);
    });

    test('keep the answer of the newer read when the older one lands first too', async () => {
        const older = createGate();
        const newer = createGate();
        const status = create(jest.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise));

        const first = status.refresh();
        const second = status.refresh();
        older.resolve([item('old.png')]);
        await first;
        newer.resolve([item('new.png')]);
        await second;

        expect(status.read()).toEqual([item('new.png')]);
    });

    test('drop the answer of an older read even when the newer one failed', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const older = createGate();
        const newer = createGate();
        const status = create(jest.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise));

        const first = status.refresh();
        const second = status.refresh();
        newer.reject(new Error('down'));
        await second;
        older.resolve([item('old.png')]);
        await first;

        expect(status.read()).toBeNull();
        warn.mockRestore();
    });
});

describe('the wait of the first render', () => {
    test('ends with the first answer when it comes within the time', async () => {
        const gate = createGate();
        const status = create(jest.fn(() => gate.promise));
        const pending = status.refresh();
        let waited = false;

        const waiting = status.waitForFirstAnswer(pending).then(() => { waited = true; });
        await Promise.resolve();
        expect(waited).toBe(false);
        gate.resolve([item('a.png')]);
        await waiting;

        expect(status.read()).toEqual([item('a.png')]);
    });

    test('ends after the time it was given when the answer does not come, and the cards are made without it', async () => {
        const gate = createGate();
        const delays = [];
        const status = create(jest.fn(() => gate.promise), { firstMountWaitMs: 300, delay: (milliseconds) => { delays.push(milliseconds); return Promise.resolve(); } });
        const pending = status.refresh();

        await status.waitForFirstAnswer(pending);

        expect(delays).toEqual([300]);
        expect(status.read()).toBeNull();
        gate.resolve([item('a.png')]);
        await pending;
        expect(status.isStale()).toBe(true);
    });

    test('is not made again once any answer was given, so a later render never waits', async () => {
        const delays = [];
        const gate = createGate();
        const status = create(jest.fn().mockResolvedValueOnce([item('a.png')]).mockReturnValueOnce(gate.promise), { delay: (milliseconds) => { delays.push(milliseconds); return new Promise(() => {}); } });
        await status.refresh();

        const slow = status.refresh();
        await status.waitForFirstAnswer(slow);

        expect(delays).toEqual([]);
        gate.resolve([]);
        await slow;
    });

    test('is not made again after a first answer that failed, because a server that fails would hold up every render', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const delays = [];
        const gate = createGate();
        const status = create(jest.fn().mockRejectedValueOnce(new Error('down')).mockReturnValueOnce(gate.promise), { delay: (milliseconds) => { delays.push(milliseconds); return new Promise(() => {}); } });
        await status.refresh();

        const slow = status.refresh();
        await status.waitForFirstAnswer(slow);

        expect(delays).toEqual([]);
        gate.resolve([]);
        await slow;
        warn.mockRestore();
    });
});

describe('a file that was just restored or updated', () => {
    test('counts as current at once, so the next render does not offer what was just done', async () => {
        const status = create(jest.fn(async () => [item('a.png'), item('b.png')]));
        await status.refresh();

        status.markCurrent('a.png');

        expect(status.read()).toEqual([item('a.png', { status: 'current', updateAvailable: false }), item('b.png')]);
    });

    test('drops a read that began before it, because that read may describe the file as it was', async () => {
        const gate = createGate();
        const status = create(jest.fn().mockResolvedValueOnce([item('a.png')]).mockReturnValueOnce(gate.promise));
        await status.refresh();
        const inFlight = status.refresh();

        status.markCurrent('a.png');
        gate.resolve([item('a.png')]);
        await inFlight;

        expect(status.read()).toEqual([item('a.png', { status: 'current', updateAvailable: false })]);
    });

    test('knows nothing more than before when no status is known', () => {
        const status = create(jest.fn());

        status.markCurrent('a.png');

        expect(status.read()).toBeNull();
    });

    test('does not change the entry that was read', async () => {
        const entries = [item('a.png')];
        const status = create(jest.fn(async () => entries));
        await status.refresh();

        status.markCurrent('a.png');

        expect(entries[0].status).toBe('modified');
    });
});

describe('what the cards were made from', () => {
    test('is current right after the cards read the status', async () => {
        const status = create(jest.fn(async () => [item('a.png')]));
        await status.refresh();

        status.read();

        expect(status.isStale()).toBe(false);
    });

    test('is stale when a read changes the status after the cards were made', async () => {
        const status = create(jest.fn().mockResolvedValueOnce([item('a.png')]).mockResolvedValueOnce([item('a.png', { status: 'current' })]));
        await status.refresh();
        status.read();

        await status.refresh();

        expect(status.isStale()).toBe(true);
    });

    test('stays current when a read answers with the same status, so the cards are not made again for nothing', async () => {
        const status = create(jest.fn(async () => [item('a.png')]));
        await status.refresh();
        status.read();

        await status.refresh();

        expect(status.isStale()).toBe(false);
    });

    test('is current again once the cards read the new status', async () => {
        const status = create(jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([item('a.png')]));
        await status.refresh();
        status.read();
        await status.refresh();

        status.read();

        expect(status.isStale()).toBe(false);
    });

    describe('when a read changes nothing that the cards show', () => {
        const staleAfter = async (before, after) => {
            const status = create(jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after));
            await status.refresh();
            status.read();
            await status.refresh();
            return status.isStale();
        };
        const sprites = overrides => item('Assistant Reisen', { type: 'sprites', ...overrides });
        const world = overrides => item('Lexicon.json', { type: 'world', ...overrides });

        test('is not stale when the first answer is empty, which is what a server with no managed content sends', async () => {
            const status = create(jest.fn(async () => []));
            status.read();

            await status.refresh();

            expect(status.isStale()).toBe(false);
        });

        test('is not stale when the first answer lists files that all need nothing', async () => {
            const status = create(jest.fn(async () => [item('a.png', { status: 'current', updateAvailable: false }), sprites({ status: 'current' })]));
            status.read();

            await status.refresh();

            expect(status.isStale()).toBe(false);
        });

        test.each([
            ['a sprite folder gets edited', [sprites({ status: 'current', updateAvailable: false })], [sprites()]],
            ['a world gets edited', [world({ status: 'current', updateAvailable: false })], [world()]],
            ['a sprite folder is deleted', [sprites({ status: 'current' })], [sprites({ status: 'deleted' })]],
            ['an unedited card is behind, which the server updates itself', [item('a.png', { status: 'current', updateAvailable: false })], [item('a.png', { status: 'updated', updateAvailable: true })]],
            ['an edited card has no update available', [item('a.png', { status: 'current', updateAvailable: false })], [item('a.png', { status: 'modified', updateAvailable: false })]],
            ['a card that nothing offers gets a newer version', [item('a.png', { status: 'current', version: 1, updateAvailable: false })], [item('a.png', { status: 'current', version: 2, updateAvailable: false })]],
            ['a card that was never installed is listed', [], [item('a.png', { status: 'not-installed', updateAvailable: false })]],
        ])('is not stale when %s', async (_case, before, after) => {
            expect(await staleAfter(before, after)).toBe(false);
        });

        test.each([
            ['a card is edited and a newer version is available', [item('a.png', { status: 'current', updateAvailable: false })], [item('a.png')]],
            ['the newer version is newer still', [item('a.png', { version: 2 })], [item('a.png', { version: 3 })]],
            ['a card is deleted', [item('a.png', { status: 'current', updateAvailable: false })], [item('a.png', { status: 'deleted', updateAvailable: false })]],
            ['a deleted card is restored', [item('a.png', { status: 'deleted', updateAvailable: false })], [item('a.png', { status: 'current', updateAvailable: false })]],
            ['the first answer offers something', null, [item('a.png', { status: 'deleted', updateAvailable: false })]],
        ])('is stale when %s', async (_case, before, after) => {
            expect(await staleAfter(before ?? [], after)).toBe(true);
        });
    });

    test('is stale when the first answer comes after cards that were made without it', async () => {
        const status = create(jest.fn(async () => [item('a.png')]));
        status.read();

        await status.refresh();

        expect(status.isStale()).toBe(true);
    });
});
