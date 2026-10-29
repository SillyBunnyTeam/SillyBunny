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
        updateThemePickerUi: jest.fn(),
        updateTopBarBrand: jest.fn(),
        scheduleTopbarContextRefresh: jest.fn(),
    });
    const functions = [
        'isSillyBunnyStorageKey', 'scheduleSbStorageFlush', 'flushSbStorageWrites', 'bindSbStorageFlushEvents',
        'safeGetItem', 'safeSetItem',
        'normalizeTopbarLabelPart', 'normalizeTopbarLabelParts', 'normalizeTopbarCustomText',
        'setDesktopTopbarLabelPart', 'setMobileTopbarLabelPart', 'setTopbarCustomText',
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
        setDesktopLabel(value, enabled) { vm.runInContext(`setDesktopTopbarLabelPart(${JSON.stringify(value)}, ${Boolean(enabled)})`, context); },
        setMobileLabel(value) { vm.runInContext(`setMobileTopbarLabelPart(${JSON.stringify(value)}, true)`, context); },
    };
}

describe('top bar label preference persistence', () => {
    test('retains desktop, mobile, and custom text choices across reloads', () => {
        const storage = createStorage();
        const shell = openShell(storage);
        shell.setDesktopLabel('ctx', true);
        shell.setMobileLabel('custom');
        shell.setCustomText('My label');
        expect(openShell(storage).label()).toMatchObject({
            desktopParts: ['ctx', 'char'],
            mobilePart: 'custom',
            customText: 'My label',
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
        shell.setMobileLabel('ctx');
        shell.setCustomText('Second label');
        expect(storage.getItem('sb-topbar-label-mobile-part')).toBe('ctx');
        expect(storage.getItem('sb-topbar-label-custom-text')).toBeNull();
        writable = true;
        shell.hide();
        expect(storage.getItem('sb-topbar-label-custom-text')).toBe('Second label');
        expect(openShell(storage).label().customText).toBe('Second label');
    });
});
