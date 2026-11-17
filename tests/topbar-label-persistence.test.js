import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/sillybunny-tabs.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function createStorage(entries = []) {
    const values = new Map(entries);
    return {
        getItem: key => values.get(key) ?? null,
        setItem: jest.fn((key, value) => values.set(key, String(value))),
        removeItem: key => values.delete(key),
    };
}

function openShell(storage) {
    let phone = false;
    const timers = new Map();
    const events = new Map();
    let nextTimer = 0;
    const context = vm.createContext({
        localStorage: storage,
        window: {
            setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
            clearTimeout: id => timers.delete(id),
            addEventListener: (name, listener) => events.set(name, listener),
        },
        document: { addEventListener: (name, listener) => events.set(name, listener) },
        normalizeText: value => String(value ?? '').trim(),
        isMobileViewport: () => phone,
        updateThemePickerUi: jest.fn(),
        updateTopBarBrand: jest.fn(),
        scheduleTopbarContextRefresh: jest.fn(),
    });
    const functions = [
        'isSillyBunnyStorageKey', 'scheduleSbStorageFlush', 'flushSbStorageWrites', 'bindSbStorageFlushEvents',
        'safeGetItem', 'safeSetItem',
        'normalizeTopbarLabelPart', 'normalizeTopbarLabelParts', 'normalizeTopbarCustomText',
        'readTopbarLabelParts', 'seedTopbarLabelParts', 'getConfiguredTopbarLabelParts', 'setTopbarLabelPart', 'setTopbarCustomText',
    ].map(name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0]);
    vm.runInContext([
        source.match(/const SB_STORAGE_KEYS = Object.freeze\(\{[\s\S]*?\n\}\);/)[0],
        source.match(/const SB_TOPBAR_LABEL_PARTS = Object.freeze\(\[[\s\S]*?\n\]\);/)[0],
        ...['SB_TOPBAR_LABEL_PART_ORDER', 'SB_TOPBAR_LABEL_PART_IDS', 'SB_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH', 'SB_STORAGE_PREFIX', 'SB_STORAGE_WRITE_DEBOUNCE_MS']
            .map(name => source.match(new RegExp(`^const ${name} = .+;`, 'm'))[0]),
        'let sbStorageFlushTimer = 0;',
        'let sbStorageFlushEventsBound = false;',
        'const sbStorageCache = new Map();',
        'const sbStoragePendingWrites = new Map();',
        ...functions,
        `const sbState = { topbarLabel: ${source.match(/ {4}topbarLabel: (\{[\s\S]*?\n {4}\}),/)[1]} };`,
        'bindSbStorageFlushEvents();',
    ].join('\n'), context);
    return {
        label() { return JSON.parse(vm.runInContext('JSON.stringify(sbState.topbarLabel)', context)); },
        hide() { events.get('pagehide')(); },
        setCustomText(value) { vm.runInContext(`setTopbarCustomText(${JSON.stringify(value)})`, context); },
        setLabelPart(value, enabled) { vm.runInContext(`setTopbarLabelPart(${JSON.stringify(value)}, ${Boolean(enabled)})`, context); },
        configured(isPhone) {
            phone = isPhone;
            return JSON.parse(vm.runInContext('JSON.stringify(getConfiguredTopbarLabelParts())', context));
        },
        seed() { vm.runInContext('seedTopbarLabelParts()', context); },
    };
}

describe('top bar label preference persistence', () => {
    test('retains the label parts and the custom text across reloads', () => {
        const storage = createStorage();
        const shell = openShell(storage);
        shell.setLabelPart('ctx', true);
        shell.setLabelPart('custom', true);
        shell.setCustomText('My label');
        expect(openShell(storage).label()).toMatchObject({
            desktopParts: ['ctx', 'char', 'custom'],
            customText: 'My label',
        });
    });

    test('reads the one stored list at every width, with ["char"] as the default', () => {
        expect(openShell(createStorage()).label().desktopParts).toEqual(['char']);
        const storage = createStorage([['sb-topbar-label-desktop-parts', '["ctx","custom"]']]);
        expect(openShell(storage).label().desktopParts).toEqual(['ctx', 'custom']);
    });

    test('shows the same list in the bar at 390 and at 1440', () => {
        const storage = createStorage([['sb-topbar-label-desktop-parts', '["char","custom"]'], ['sb-topbar-label-mobile-part', 'ctx']]);
        const shell = openShell(storage);
        expect(shell.configured(true)).toEqual(['char', 'custom']);
        expect(shell.configured(false)).toEqual(['char', 'custom']);
        shell.setLabelPart('ctx', true);
        expect(shell.configured(true)).toEqual(['ctx', 'char', 'custom']);
        expect(shell.configured(false)).toEqual(['ctx', 'char', 'custom']);
    });

    describe('migration from the phone value', () => {
        test.each([
            ['a part', 'ctx', ['ctx']],
            ['an empty value', '', []],
            ['an unknown value', 'nonsense', []],
        ])('seeds the list from %s when only the phone key exists', (_name, phone, expected) => {
            const storage = createStorage([['sb-topbar-label-mobile-part', phone]]);
            const shell = openShell(storage);
            expect(shell.label().desktopParts).toEqual(expected);
            shell.seed();
            expect(storage.getItem('sb-topbar-label-desktop-parts')).toBe(JSON.stringify(expected));
            shell.hide();
            expect(storage.getItem('sb-topbar-label-mobile-part')).toBe(phone);
        });

        test('keeps the list when both keys exist, and does not touch the phone key', () => {
            const storage = createStorage([
                ['sb-topbar-label-desktop-parts', '["char","ctx"]'],
                ['sb-topbar-label-mobile-part', 'custom'],
            ]);
            const shell = openShell(storage);
            shell.seed();
            expect(shell.label().desktopParts).toEqual(['ctx', 'char']);
            expect(storage.getItem('sb-topbar-label-desktop-parts')).toBe('["char","ctx"]');
            expect(storage.getItem('sb-topbar-label-mobile-part')).toBe('custom');
        });

        test('writes nothing when neither key exists', () => {
            const storage = createStorage();
            const shell = openShell(storage);
            shell.seed();
            expect(storage.setItem).not.toHaveBeenCalled();
            expect(shell.label().desktopParts).toEqual(['char']);
        });

        test('never writes the phone key, and a later change to the list wins over the phone value', () => {
            const storage = createStorage([['sb-topbar-label-mobile-part', 'ctx']]);
            const shell = openShell(storage);
            shell.seed();
            shell.setLabelPart('char', true);
            expect(storage.setItem.mock.calls.map(([key]) => key)).not.toContain('sb-topbar-label-mobile-part');
            expect(openShell(storage).label().desktopParts).toEqual(['ctx', 'char']);
        });
    });

    test('retries an unsaved choice after a transient browser storage failure instead of resetting on reload', () => {
        const storage = createStorage();
        storage.setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
        const shell = openShell(storage);
        shell.setCustomText('My label');
        expect(storage.getItem('sb-topbar-label-custom-text')).toBeNull();
        expect(shell.label().customText).toBe('My label');
        shell.hide();
        expect(openShell(storage).label().customText).toBe('My label');
    });

    test('retries failed settings without dropping other writes or reverting a newer choice', () => {
        const storage = createStorage();
        const setItem = storage.setItem.getMockImplementation();
        let writable = false;
        storage.setItem.mockImplementation((key, value) => {
            if (!writable && key === 'sb-topbar-label-custom-text') {
                throw new Error('Storage unavailable');
            }
            return setItem(key, value);
        });
        const shell = openShell(storage);
        shell.setCustomText('First label');
        shell.setLabelPart('ctx', true);
        shell.setCustomText('Second label');
        expect(storage.getItem('sb-topbar-label-desktop-parts')).toBe('["ctx","char"]');
        expect(storage.getItem('sb-topbar-label-custom-text')).toBeNull();
        writable = true;
        shell.hide();
        expect(storage.getItem('sb-topbar-label-custom-text')).toBe('Second label');
        expect(openShell(storage).label().customText).toBe('Second label');
    });
});
