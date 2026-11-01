/* eslint-disable playwright/no-standalone-expect -- Jest contracts for when Welcome opens and what it persists. */
import { describe, expect, jest, test } from '@jest/globals';

const { IMPORT_PENDING_KEY, SEEN_VERSION_KEY, SHOW_AT_STARTUP_KEY, createWelcomeStartup } = await import('../../public/scripts/sillybunny-welcome-startup.js');
const { DEFAULT_USER_NAME, UNNAMED_PERSONA_NAME, isUntouchedDefaultPersona, savePersonaName } = await import('../../public/scripts/sillybunny-welcome-persona.js');
const { createSillyTavernImport } = await import('../../public/scripts/sillybunny-welcome-import.js');

const VERSION = '9.9.9';

/** A key-value store that reads and writes strings, as `accountStorage` and `localStorage` do. */
function createStore(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => void values.set(key, String(value)),
        removeItem: key => void values.delete(key),
        snapshot: () => Object.fromEntries(values),
    };
}

function boot({ account = {}, local = {} } = {}) {
    const stores = { account: createStore(account), local: createStore(local) };
    return { ...stores, startup: createWelcomeStartup({ ...stores, version: VERSION }) };
}

describe('when Welcome opens at startup', () => {
    test('a first run opens it with the persona required, and it writes nothing until the persona is named', () => {
        const { startup, account } = boot();

        const plan = startup.decide({ firstRun: true });

        expect(plan).toEqual({ open: true, reason: 'first-run' });
        expect(account.snapshot()).toEqual({});
    });

    test('naming the persona on a first run turns Show at Startup on and records the seen version', () => {
        const { startup, account } = boot();
        startup.decide({ firstRun: true });

        startup.completeFirstRun();

        expect(account.snapshot()).toEqual({ [SHOW_AT_STARTUP_KEY]: 'true', [SEEN_VERSION_KEY]: VERSION });
    });

    test('Show at Startup on opens it, with the persona in its reopen form', () => {
        const { startup } = boot({ account: { [SHOW_AT_STARTUP_KEY]: 'true', [SEEN_VERSION_KEY]: '1.0.0' } });

        expect(startup.decide({ firstRun: false })).toEqual({ open: true, reason: 'show-at-startup' });
    });

    test('Show at Startup on without a seen version records the version, so that turning it off later does not open it once more', () => {
        const { startup, account } = boot({ account: { [SHOW_AT_STARTUP_KEY]: 'true' } });

        startup.decide({ firstRun: false });

        expect(account.getItem(SEEN_VERSION_KEY)).toBe(VERSION);
        expect(account.getItem(SHOW_AT_STARTUP_KEY)).toBe('true');
    });

    test('an existing account that never saw Welcome gets it once, with Show at Startup off', () => {
        const { startup, account } = boot({ account: { someOtherKey: 'x' } });

        const plan = startup.decide({ firstRun: false });

        expect(plan).toEqual({ open: true, reason: 'new-to-welcome' });
        expect(account.snapshot()).toEqual({ someOtherKey: 'x', [SHOW_AT_STARTUP_KEY]: 'false', [SEEN_VERSION_KEY]: VERSION });
        expect(startup.isShownAtStartup()).toBe(false);
    });

    test('the next boot of that account does not open it again', () => {
        const first = boot();
        first.startup.decide({ firstRun: false });

        const next = createWelcomeStartup({ account: first.account, local: first.local, version: VERSION });

        expect(next.decide({ firstRun: false })).toEqual({ open: false, reason: 'not-needed' });
    });

    test('an account that saw Welcome and turned Show at Startup off never opens it', () => {
        const { startup } = boot({ account: { [SHOW_AT_STARTUP_KEY]: 'false', [SEEN_VERSION_KEY]: '1.0.0' } });

        expect(startup.decide({ firstRun: false })).toEqual({ open: false, reason: 'not-needed' });
    });

    test('it decides once per boot: the first run that was handled does not open Welcome again at APP_READY', () => {
        const { startup } = boot();
        startup.decide({ firstRun: true });
        startup.completeFirstRun();

        expect(startup.decide({ firstRun: false })).toEqual({ open: false, reason: 'decided' });
    });

    test('Show at Startup reads and writes the account', () => {
        const { startup, account } = boot();

        startup.setShownAtStartup(true);
        expect(account.getItem(SHOW_AT_STARTUP_KEY)).toBe('true');
        expect(startup.isShownAtStartup()).toBe(true);

        startup.setShownAtStartup(false);
        expect(account.getItem(SHOW_AT_STARTUP_KEY)).toBe('false');
        expect(startup.isShownAtStartup()).toBe(false);
    });
});

describe('the import marker', () => {
    test.each([
        ['on a first run', true],
        ['on a boot of an existing account', false],
    ])('never opens Welcome %s, and applies what an import means: seen, Show at Startup off, marker cleared', (_label, firstRun) => {
        const { startup, account, local } = boot({ local: { [IMPORT_PENDING_KEY]: '1' } });

        const plan = startup.decide({ firstRun });

        expect(plan).toEqual({ open: false, reason: 'import' });
        expect(account.snapshot()).toEqual({ [SHOW_AT_STARTUP_KEY]: 'false', [SEEN_VERSION_KEY]: VERSION });
        expect(local.getItem(IMPORT_PENDING_KEY)).toBeNull();
    });

    test('replaces what the imported settings say about Show at Startup', () => {
        const { startup, account } = boot({ account: { [SHOW_AT_STARTUP_KEY]: 'true' }, local: { [IMPORT_PENDING_KEY]: '1' } });

        startup.decide({ firstRun: false });

        expect(account.getItem(SHOW_AT_STARTUP_KEY)).toBe('false');
    });

    test('is set before an import and cleared when the import failed', () => {
        const { startup, local } = boot();

        startup.markImportPending();
        expect(local.getItem(IMPORT_PENDING_KEY)).toBe('1');

        startup.clearImportPending();
        expect(local.getItem(IMPORT_PENDING_KEY)).toBeNull();
    });

    test('set by an import, it keeps Welcome closed on the boot that follows', () => {
        const first = boot();
        first.startup.markImportPending();

        const next = createWelcomeStartup({ account: first.account, local: first.local, version: VERSION });

        expect(next.decide({ firstRun: false })).toEqual({ open: false, reason: 'import' });
    });

    test('is consumed once, so the boot after it follows the normal rules', () => {
        const first = boot({ local: { [IMPORT_PENDING_KEY]: '1' } });
        first.startup.decide({ firstRun: false });

        const next = createWelcomeStartup({ account: first.account, local: first.local, version: VERSION });

        expect(next.decide({ firstRun: false })).toEqual({ open: false, reason: 'not-needed' });
    });
});

describe('the persona that Welcome writes', () => {
    function setup() {
        return {
            setUserName: jest.fn(),
            powerUser: { personas: {}, persona_descriptions: {} },
            positions: { IN_PROMPT: 0 },
        };
    }

    test('writes what the onboarding popup wrote: the user name, the persona of the avatar, and an empty description in the prompt', () => {
        const deps = setup();

        const saved = savePersonaName({ avatarId: 'user-default.png', name: 'Ada' }, deps);

        expect(saved).toBe(true);
        expect(deps.setUserName).toHaveBeenCalledWith('Ada');
        expect(deps.powerUser.personas).toEqual({ 'user-default.png': 'Ada' });
        expect(deps.powerUser.persona_descriptions).toEqual({ 'user-default.png': { description: '', position: 0 } });
    });

    test('replaces the first line break with a space, as the popup did', () => {
        const deps = setup();

        savePersonaName({ avatarId: 'a.png', name: 'Ada\nLovelace' }, deps);

        expect(deps.setUserName).toHaveBeenCalledWith('Ada Lovelace');
        expect(deps.powerUser.personas['a.png']).toBe('Ada Lovelace');
    });

    test('writes the trimmed name', () => {
        const deps = setup();

        savePersonaName({ avatarId: 'a.png', name: '  Ada  ' }, deps);

        expect(deps.powerUser.personas['a.png']).toBe('Ada');
    });

    test.each(['', '   ', undefined])('writes nothing for the name %j', (name) => {
        const deps = setup();

        const saved = savePersonaName({ avatarId: 'a.png', name }, deps);

        expect(saved).toBe(false);
        expect(deps.setUserName).not.toHaveBeenCalled();
        expect(deps.powerUser.personas).toEqual({});
        expect(deps.powerUser.persona_descriptions).toEqual({});
    });
});

describe('the untouched default persona', () => {
    const AVATAR = 'user-default.png';
    /** The persona the app binds on boot to an avatar that has none: the default name and empty fields. */
    const bound = (overrides = {}) => ({
        description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '', appendices: [], activeAppendices: {}, ...overrides,
    });
    const powerUserWith = ({ name = DEFAULT_USER_NAME, descriptor = bound(), defaultPersona = null } = {}) => ({
        personas: name === undefined ? {} : { [AVATAR]: name },
        persona_descriptions: descriptor === undefined ? {} : { [AVATAR]: descriptor },
        default_persona: defaultPersona,
    });
    const untouched = (powerUser, userName = DEFAULT_USER_NAME) => isUntouchedDefaultPersona({ avatarId: AVATAR, userName }, { powerUser });

    test('is the default name on the persona that the app bound on boot', () => {
        expect(DEFAULT_USER_NAME).toBe('User');
        expect(untouched(powerUserWith())).toBe(true);
    });

    test('is also the unnamed persona that the app binds to an avatar that has none', () => {
        expect(untouched(powerUserWith({ name: UNNAMED_PERSONA_NAME }))).toBe(true);
    });

    test('is also an avatar that has no persona entry yet', () => {
        expect(untouched(powerUserWith({ name: undefined, descriptor: undefined }))).toBe(true);
    });

    test('is not any other user name', () => {
        expect(untouched(powerUserWith({ name: 'Ada' }), 'Ada')).toBe(false);
        expect(untouched(powerUserWith(), 'user')).toBe(false);
    });

    test('is not a persona whose bound name differs from the user name, whatever the user name says', () => {
        expect(untouched(powerUserWith({ name: 'Ada' }))).toBe(false);
    });

    test.each([
        ['a description', { description: 'Tall.' }],
        ['a title', { title: 'Captain' }],
        ['a lorebook', { lorebook: 'World' }],
        ['a chat connection', { connections: [{ type: 'chat', id: 'a' }] }],
        ['an appendix', { appendices: [{ id: 'x' }] }],
    ])('is not a persona with %s', (_label, change) => {
        expect(untouched(powerUserWith({ descriptor: bound(change) }))).toBe(false);
    });

    test('ignores white space in a description or a title', () => {
        expect(untouched(powerUserWith({ descriptor: bound({ description: '  \n ', title: ' ' }) }))).toBe(true);
    });

    test('is not the persona that the account set as its default', () => {
        expect(untouched(powerUserWith({ defaultPersona: AVATAR }))).toBe(false);
    });

    test('is still untouched when the account has other personas', () => {
        const powerUser = powerUserWith();
        powerUser.personas['other.png'] = 'Ada';
        powerUser.persona_descriptions['other.png'] = bound({ description: 'Tall.' });
        expect(untouched(powerUser)).toBe(true);
    });

    test('is what savePersonaName turns into a touched persona', () => {
        const powerUser = powerUserWith();
        savePersonaName({ avatarId: AVATAR, name: 'Ada' }, { setUserName: jest.fn(), powerUser, positions: { IN_PROMPT: 0 } });
        expect(untouched(powerUser, 'Ada')).toBe(false);
    });
});

describe('importing from SillyTavern', () => {
    function setup({ confirmed = true, request = jest.fn(async () => ({ message: 'Imported.' })) } = {}) {
        const local = createStore();
        const reload = jest.fn();
        const confirm = jest.fn(async () => confirmed);
        const importer = createSillyTavernImport({
            request,
            confirm,
            reload,
            markImportPending: () => local.setItem(IMPORT_PENDING_KEY, '1'),
            clearImportPending: () => local.removeItem(IMPORT_PENDING_KEY),
        });
        return { importer, request, confirm, reload, local };
    }

    test('a folder import asks first, sets the marker before the request, and reloads when it succeeds', async () => {
        const seenAtRequest = [];
        const { importer, local, request, reload } = setup({
            request: jest.fn(async () => {
                seenAtRequest.push(local.getItem(IMPORT_PENDING_KEY));
                return { message: 'Imported 3 sections.' };
            }),
        });

        const result = await importer.importFolder('  /home/me/SillyTavern ');

        expect(request).toHaveBeenCalledWith('/api/users/import-sillytavern/folder', { body: { sourcePath: '/home/me/SillyTavern' } });
        expect(seenAtRequest).toEqual(['1']);
        expect(local.getItem(IMPORT_PENDING_KEY)).toBe('1');
        expect(result).toEqual({ status: 'imported', message: 'Imported 3 sections.' });
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('a zip import sends the file as a form upload', async () => {
        const { importer, request } = setup();
        const file = new File(['zip'], 'backup.zip');

        const result = await importer.importZip(file);

        expect(request).toHaveBeenCalledTimes(1);
        const [endpoint, options] = request.mock.calls[0];
        expect(endpoint).toBe('/api/users/import-sillytavern/zip');
        expect(options.useFormData).toBe(true);
        expect(options.body.get('avatar').name).toBe('backup.zip');
        expect(result.status).toBe('imported');
    });

    test('an empty path asks for nothing, sets no marker and sends no request', async () => {
        const { importer, request, confirm, local } = setup();

        const result = await importer.importFolder('   ');

        expect(result).toEqual({ status: 'empty' });
        expect(confirm).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(local.getItem(IMPORT_PENDING_KEY)).toBeNull();
    });

    test('a declined confirmation sets no marker and sends no request', async () => {
        const { importer, request, local, reload } = setup({ confirmed: false });

        const result = await importer.importFolder('/x');

        expect(result).toEqual({ status: 'cancelled' });
        expect(request).not.toHaveBeenCalled();
        expect(local.getItem(IMPORT_PENDING_KEY)).toBeNull();
        expect(reload).not.toHaveBeenCalled();
    });

    test('a failed request clears the marker, so that a boot of an account that was not imported is not mistaken for one, and does not reload', async () => {
        const { importer, local, reload } = setup({ request: jest.fn(async () => { throw new Error('That folder is already the current SillyBunny account.'); }) });

        const result = await importer.importFolder('/x');

        expect(result).toEqual({ status: 'failed', message: 'That folder is already the current SillyBunny account.' });
        expect(local.getItem(IMPORT_PENDING_KEY)).toBeNull();
        expect(reload).not.toHaveBeenCalled();
    });

    test('a second import while one runs is ignored', async () => {
        let release;
        const request = jest.fn(() => new Promise((resolve) => { release = () => resolve({ message: 'ok' }); }));
        const { importer } = setup({ request });

        const first = importer.importFolder('/x');
        await Promise.resolve();
        await Promise.resolve();
        const second = await importer.importFolder('/y');
        release();
        await first;

        expect(second).toEqual({ status: 'busy' });
        expect(request).toHaveBeenCalledTimes(1);
    });
});
