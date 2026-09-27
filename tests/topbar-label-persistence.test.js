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

function openShell(storage, mobile = false) {
    const timers = new Map();
    const events = new Map();
    let nextTimer = 0;
    const cycleTopBarLabel = jest.fn();
    const returnToChatSurface = jest.fn();
    const context = vm.createContext({
        localStorage: storage,
        window: {
            matchMedia: () => ({ matches: mobile }),
            setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
            clearTimeout: id => timers.delete(id),
            addEventListener: (name, listener) => events.set(name, listener),
        },
        document: { addEventListener: (name, listener) => events.set(name, listener) },
        normalizeText: value => String(value ?? '').trim(),
        updateThemePickerUi: jest.fn(),
        updateTopBarBrand: jest.fn(),
        resetTopBarLabelCycle: jest.fn(),
        scheduleTopbarContextRefresh: jest.fn(),
        cycleTopBarLabel,
        returnToChatSurface,
    });
    const functions = [
        'isSillyBunnyStorageKey', 'scheduleSbStorageFlush', 'flushSbStorageWrites', 'bindSbStorageFlushEvents',
        'safeGetItem', 'safeSetItem', 'safeRemoveItem', 'normalizeStoredBoolean',
        'normalizeTopbarLabelPart', 'normalizeTopbarLabelParts', 'normalizeTopbarCustomText',
        'isMobileViewport', 'readTopbarLabelClickCycle', 'isTopbarLabelClickCycleEnabled',
        'setTopbarLabelClickCycle', 'setTopbarCustomText', 'setMobileTopbarLabelPart',
        'handleTopBarTitleActivation',
    ].map(name => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0]);
    vm.runInContext([
        source.match(/const SB_STORAGE_KEYS = Object.freeze\(\{[\s\S]*?\n\}\);/)[0],
        source.match(/const SB_TOPBAR_LABEL_PARTS = Object.freeze\(\[[\s\S]*?\n\]\);/)[0],
        ...['SB_TOPBAR_LABEL_PART_ORDER', 'SB_TOPBAR_LABEL_PART_IDS', 'SB_TOPBAR_LABEL_CUSTOM_TEXT_MAX_LENGTH', 'SB_MOBILE_MEDIA_QUERY', 'SB_STORAGE_PREFIX', 'SB_STORAGE_WRITE_DEBOUNCE_MS']
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
        setMobile(value) { mobile = value; },
        setClickCycle(value) { vm.runInContext(`setTopbarLabelClickCycle(${Boolean(value)})`, context); },
        activate() {
            cycleTopBarLabel.mockClear();
            returnToChatSurface.mockClear();
            vm.runInContext('handleTopBarTitleActivation()', context);
            if (cycleTopBarLabel.mock.calls.length === 1 && returnToChatSurface.mock.calls.length === 0) {
                return 'preview';
            }
            if (returnToChatSurface.mock.calls.length === 1 && cycleTopBarLabel.mock.calls.length === 0) {
                return 'chat';
            }
            return 'unexpected activation';
        },
        hide() { events.get('pagehide')(); },
        setCustomText(value) { vm.runInContext(`setTopbarCustomText(${JSON.stringify(value)})`, context); },
        setMobileLabel(value) { vm.runInContext(`setMobileTopbarLabelPart(${JSON.stringify(value)}, true)`, context); },
    };
}

describe('top bar label preference persistence', () => {
    test('retains independent desktop and mobile click actions across viewport changes and reloads', () => {
        const storage = createStorage();
        const shell = openShell(storage);
        shell.setClickCycle(false);
        shell.setMobile(true);
        shell.setClickCycle(true);
        expect(shell.activate()).toBe('preview');
        shell.setMobile(false);
        expect(shell.activate()).toBe('chat');
        expect(openShell(storage).activate()).toBe('chat');
        expect(openShell(storage, true).activate()).toBe('preview');
    });

    test('preserves a legacy disabled click action when the other platform changes its choice', () => {
        const storage = createStorage([['sb-topbar-label-click-cycle', 'false']]);
        const shell = openShell(storage, true);
        expect(shell.activate()).toBe('chat');
        shell.setClickCycle(true);
        expect(openShell(storage, true).activate()).toBe('preview');
        expect(openShell(storage).activate()).toBe('chat');
        expect(storage.getItem('sb-topbar-label-click-cycle')).toBe('false');
    });

    test('does not overwrite another browser device when a click action is changed', () => {
        const desktopStorage = createStorage();
        const mobileStorage = createStorage();
        openShell(desktopStorage).setClickCycle(false);
        openShell(mobileStorage, true).setClickCycle(true);
        expect(openShell(desktopStorage).activate()).toBe('chat');
        expect(openShell(mobileStorage, true).activate()).toBe('preview');
    });

    test('retries an unsaved choice after a transient browser storage failure instead of resetting on reload', () => {
        const storage = createStorage();
        storage.setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
        const shell = openShell(storage);
        shell.setClickCycle(false);
        expect(shell.activate()).toBe('chat');
        shell.hide();
        expect(openShell(storage).activate()).toBe('chat');
    });

    test('retries failed settings without dropping other writes or reverting a newer choice', () => {
        const storage = createStorage();
        const setItem = storage.setItem.getMockImplementation();
        let writable = false;
        storage.setItem.mockImplementation((key, value) => {
            if (!writable && key === 'sb-topbar-label-click-cycle-desktop') {
                throw new Error('Storage unavailable');
            }
            return setItem(key, value);
        });
        const shell = openShell(storage);
        shell.setClickCycle(false);
        shell.setCustomText('My label');
        shell.setClickCycle(true);
        shell.setMobileLabel('ctx');
        expect(storage.getItem('sb-topbar-label-custom-text')).toBe('My label');
        expect(storage.getItem('sb-topbar-label-mobile-part')).toBe('ctx');
        writable = true;
        shell.hide();
        expect(storage.getItem('sb-topbar-label-click-cycle-desktop')).toBe('true');
        expect(openShell(storage).activate()).toBe('preview');
    });

    test('prefers a saved layout choice over the legacy default, including false values', () => {
        const storage = createStorage([
            ['sb-topbar-label-click-cycle', 'true'],
            ['sb-topbar-label-click-cycle-desktop', 'false'],
            ['sb-topbar-label-click-cycle-mobile', 'true'],
        ]);
        expect(openShell(storage).activate()).toBe('chat');
        expect(openShell(storage, true).activate()).toBe('preview');
    });
});
