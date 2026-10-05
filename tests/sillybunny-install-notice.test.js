import { beforeAll, describe, expect, jest, test } from '@jest/globals';

let doInstallNoticeCheck;
let INSTALL_NOTICE_STORAGE_KEY;

beforeAll(async () => {
    jest.unstable_mockModule('../public/script.js', () => ({ getRequestHeaders: jest.fn(() => ({})) }));
    jest.unstable_mockModule('../public/scripts/events.js', () => ({ eventSource: { once: jest.fn() }, event_types: { APP_READY: 'app_ready' } }));
    jest.unstable_mockModule('../public/scripts/user.js', () => ({ isAdmin: jest.fn(() => true) }));
    jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: jest.fn(), setItem: jest.fn() } }));
    ({ doInstallNoticeCheck, INSTALL_NOTICE_STORAGE_KEY } = await import('../public/scripts/sillybunny-install-notice.js'));
});

function createStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: jest.fn(key => values.get(key) ?? null),
        setItem: jest.fn((key, value) => values.set(key, value)),
    };
}

function respondWith(installType, ok = true) {
    return jest.fn(async () => ({ ok, json: async () => ({ installType }) }));
}

const now = new Date('2026-10-04T12:00:00Z');

describe('non-Git install notice', () => {
    test('notifies admins of unsupported installs once per day', async () => {
        const storage = createStorage();
        const notify = jest.fn();
        const fetchImpl = respondWith('unsupported');
        const deps = { storage, notify, fetchImpl, checkAdmin: () => true, getHeaders: () => ({}), now };

        await expect(doInstallNoticeCheck(deps)).resolves.toBe(true);
        await expect(doInstallNoticeCheck(deps)).resolves.toBe(false);

        expect(notify).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith('/api/server-admin/install-type', expect.objectContaining({ method: 'POST' }));
        expect(storage.getItem(INSTALL_NOTICE_STORAGE_KEY)).toBe(now.toDateString());
    });

    test('stays quiet for Git and Docker installs', async () => {
        const notify = jest.fn();
        for (const installType of ['git', 'docker']) {
            await expect(doInstallNoticeCheck({ storage: createStorage(), notify, fetchImpl: respondWith(installType), checkAdmin: () => true, getHeaders: () => ({}), now })).resolves.toBe(false);
        }
        expect(notify).not.toHaveBeenCalled();
    });

    test('skips non-admins without a request', async () => {
        const fetchImpl = respondWith('unsupported');
        await expect(doInstallNoticeCheck({ storage: createStorage(), notify: jest.fn(), fetchImpl, checkAdmin: () => false, getHeaders: () => ({}), now })).resolves.toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('retries on a later load when the request fails', async () => {
        const storage = createStorage();
        await expect(doInstallNoticeCheck({ storage, notify: jest.fn(), fetchImpl: respondWith('unsupported', false), checkAdmin: () => true, getHeaders: () => ({}), now })).resolves.toBe(false);
        await expect(doInstallNoticeCheck({ storage, notify: jest.fn(), fetchImpl: jest.fn(async () => { throw new Error('offline'); }), checkAdmin: () => true, getHeaders: () => ({}), now })).resolves.toBe(false);
        expect(storage.setItem).not.toHaveBeenCalled();
    });
});
