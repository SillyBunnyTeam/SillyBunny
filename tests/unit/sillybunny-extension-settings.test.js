/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom tests use synchronous DOM assertions. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateHeightFrom: jest.fn(),
    animateIn: jest.fn(),
    animateOut: jest.fn((_element, _frames, hide) => hide()),
    play: jest.fn(),
    stopMotion: jest.fn(),
    MOTION_FAST: 200,
    MOTION_SLOW: 250,
    MOTION_POPOVER_CLOSE: 150,
    MOTION_EASE_OUT_CUBIC: 'cubic-bezier(0.33, 1, 0.68, 1)',
    SPRING_SHEET: {},
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '(max-width: 768px)',
    positionPopover: jest.fn(() => '0px 0'),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-sheet.js', () => ({
    blockUpstreamDrawerClose: jest.fn(),
    createSheetController: jest.fn(),
}));

const { normalizeExtensionSettings, normalizeSettingsDetail, resolveFieldLabel, watchExtensionSettings } = await import('../../public/scripts/sillybunny-settings-presentation.js');
const { buildExtensionsSubpage, isBuiltInExtensionContainer } = await import('../../public/scripts/sillybunny-settings-subpage-descriptors.js');
const { closePicker } = await import('../../public/scripts/sillybunny-editor/picker.js');

const tabs = readFileSync(new URL('../../public/scripts/sillybunny-tabs.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    document.body.replaceChildren();
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: jest.fn(() => ({ matches: false })) });
});

afterEach(() => {
    closePicker({ animate: false });
    document.body.replaceChildren();
});

/** Mounts markup in a container the way an extension's settings template lands in the page. */
function mount(html, id = 'vectors_container') {
    const container = document.createElement('div');
    container.id = id;
    container.className = 'extension_container';
    container.innerHTML = html;
    document.body.append(container);
    return container;
}

const field = (container, selector) => /** @type {HTMLInputElement} */ (container.querySelector(selector));
const titleOf = control => control.closest('.ds-row')?.querySelector('.ds-row-label')?.textContent.trim();

describe('resolveFieldLabel', () => {
    test('reads a label that points at the control, without its icons and help links', () => {
        const container = mount('<div><label for="a">Server URL: <a href="#" class="notes-link">?</a><i class="fa-solid fa-circle-info"></i></label><input id="a" type="text"></div>');
        const found = resolveFieldLabel(field(container, '#a'));
        expect(found).toMatchObject({ title: 'Server URL', source: 'label' });
        expect(found.nodes).toEqual([container.querySelector('label')]);
    });

    test('prefers the label that shares the control\'s wrapper when several point at it', () => {
        const container = mount(`
            <div><div id="one"><label for="shared"><small>Query messages</small></label><input id="shared" type="number"></div>
            <div id="two"><label for="shared"><small>Score threshold</small></label><input id="other" type="number"></div></div>`);
        expect(resolveFieldLabel(field(container, '#shared')).title).toBe('Query messages');
    });

    test('reads a wrapping label', () => {
        const container = mount('<label>Seed <input id="a" type="text"></label>');
        expect(resolveFieldLabel(field(container, '#a'))).toMatchObject({ title: 'Seed', source: 'wrapping-label' });
    });

    test('reads an aria-label when no label exists', () => {
        const container = mount('<div><input id="a" type="text" aria-label="Connection Profile" placeholder="ignored"></div>');
        expect(resolveFieldLabel(field(container, '#a'))).toMatchObject({ title: 'Connection Profile', source: 'aria-label', nodes: [] });
    });

    test('reads the label text right before the control', () => {
        const container = mount('<div id="tts_regex_block"><div class="range-block-title"><small>Regex Pattern (removes matching text)</small></div><input id="a" type="text" placeholder="Example"></div>');
        const found = resolveFieldLabel(field(container, '#a'));
        expect(found).toMatchObject({ title: 'Regex Pattern (removes matching text)', source: 'preceding' });
        expect(found.nodes).toEqual([container.querySelector('.range-block-title')]);
    });

    test('reads a label that points at another control when it sits right before this one', () => {
        const container = mount('<div><label for="query"><small>Score threshold</small></label><input id="threshold" type="number"></div>');
        expect(resolveFieldLabel(field(container, '#threshold'))).toMatchObject({ title: 'Score threshold', source: 'preceding' });
    });

    test('does not borrow the text of a neighbour that belongs to another field', () => {
        const container = mount('<div><label for="first">First</label><input id="first" type="text"><input id="second" type="text"></div>');
        expect(resolveFieldLabel(field(container, '#second'))).toBeNull();
    });

    test('does not take loose text for a label, because it cannot be retired', () => {
        const container = mount('<div>Name <input id="a" type="text"></div>');
        expect(resolveFieldLabel(field(container, '#a'))).toBeNull();
    });

    test('takes the placeholder as the title when nothing names the control', () => {
        const container = mount('<div><input id="a" type="text" placeholder="Model tag, e.g. llama3"></div>');
        expect(resolveFieldLabel(field(container, '#a'))).toMatchObject({ title: 'Model tag, e.g. llama3', source: 'placeholder', nodes: [] });
    });

    test('returns null for a control with no label and no placeholder', () => {
        const container = mount('<div><input id="a" type="text"></div>');
        expect(resolveFieldLabel(field(container, '#a'))).toBeNull();
    });
});

describe('the adopter', () => {
    test('moves a labelled text input into a floating row inside its own wrapper, keeping the node, id, value and listeners', () => {
        const container = mount('<div id="wrapper" class="flex-container flexFlowColumn"><label for="addr" data-i18n="Secondary Embedding endpoint URL">Secondary Embedding endpoint URL</label><input id="addr" class="text_pole" type="text" placeholder="e.g. http://localhost:5001" value="http://a"></div>');
        const input = field(container, '#addr');
        const wrapper = container.querySelector('#wrapper');
        const seen = [];
        input.addEventListener('input', () => seen.push(input.value));

        const report = normalizeExtensionSettings(container);

        expect(report.entries).toBe(1);
        expect(field(container, '#addr')).toBe(input);
        expect(input.value).toBe('http://a');
        const row = input.closest('.ds-row-entry--floating');
        expect(row.parentElement).toBe(wrapper);
        expect(row.querySelector('.ds-row-label').textContent).toBe('Secondary Embedding endpoint URL');
        expect(row.querySelector('.ds-row-label').dataset.i18n).toBe('Secondary Embedding endpoint URL');
        input.value = 'http://b';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(seen).toEqual(['http://b']);
        // The adopted placeholder stays as the accessible description and is not painted.
        expect(input.getAttribute('placeholder')).toBe(' ');
        expect(input.getAttribute('aria-description')).toBe('e.g. http://localhost:5001');
    });

    test('names the field once: the old label is hidden and leaves the control\'s label list', () => {
        const container = mount('<div><label for="addr">Address</label><input id="addr" type="text"></div>');
        normalizeExtensionSettings(container);

        const input = field(container, '#addr');
        const names = [...input.labels].filter(label => !label.classList.contains('sb-legacy-search-hidden')).map(label => label.textContent.trim());
        expect(names).toEqual(['Address']);
        expect(input.labels).toHaveLength(1);
        const old = container.querySelector('[data-sb-adopted-label]');
        expect(old.classList.contains('sb-legacy-search-hidden')).toBe(true);
        expect(old.hasAttribute('for')).toBe(false);
        expect(old.dataset.sbAdoptedFor).toBe('addr');
    });

    test('uses the placeholder as the title when no label exists, and does not repeat it as the description', () => {
        const container = mount('<div><input id="model" type="text" placeholder="Model tag, e.g. llama3"></div>');
        normalizeExtensionSettings(container);

        const input = field(container, '#model');
        expect(titleOf(input)).toBe('Model tag, e.g. llama3');
        expect(input.hasAttribute('aria-description')).toBe(false);
    });

    test('moves the Connect button beside a field into the row\'s trailing slot', () => {
        const container = mount('<div><label for="url">SD Web UI URL</label><div class="flex-container flexnowrap"><input id="url" type="text"><div id="validate" class="menu_button"><span>Connect</span></div></div></div>');
        const button = container.querySelector('#validate');
        const clicks = jest.fn();
        button.addEventListener('click', clicks);

        normalizeExtensionSettings(container);

        expect(container.querySelector('#validate')).toBe(button);
        expect(button.closest('.ds-row-entry--floating .ds-row-suffix')).not.toBeNull();
        button.click();
        expect(clicks).toHaveBeenCalledTimes(1);
    });

    test('moves a refresh button that sits in the title bar with the label', () => {
        const container = mount('<div><div class="flex-container" id="bar"><label for="model">Model</label><button id="refresh" type="button" class="menu_button">r</button></div><select id="model"><option value="a">A</option></select></div>');
        normalizeExtensionSettings(container);

        expect(container.querySelector('#refresh').closest('.ds-select-row .ds-row-suffix')).not.toBeNull();
        expect(container.querySelector('#bar').classList.contains('sb-legacy-search-hidden')).toBe(true);
    });

    test('puts a select in a select row, adopted in place, and a change through the row reaches the extension', () => {
        const container = mount('<div id="wrapper"><label for="src">Source</label><select id="src" class="text_pole"><option value="a">Alpha</option><option value="b">Beta</option></select></div>');
        const select = field(container, '#src');
        const changed = jest.fn();
        select.addEventListener('change', changed);

        expect(normalizeExtensionSettings(container).selects).toBe(1);

        const row = select.closest('.ds-select-row');
        expect(row.parentElement).toBe(container.querySelector('#wrapper'));
        expect(row.querySelector('.ds-row-label').textContent).toBe('Source');
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('Alpha');
        select.value = 'b';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(changed).toHaveBeenCalledTimes(1);
        expect(row.querySelector('.ds-select-row__value').textContent).toBe('Beta');
    });

    test('follows a value the extension wrote without an event when the page is presented again', () => {
        const container = mount('<div><label for="src">Source</label><select id="src"><option value="a">Alpha</option><option value="b">Beta</option></select></div>');
        normalizeExtensionSettings(container);
        field(container, '#src').value = 'b';

        normalizeExtensionSettings(container);

        expect(container.querySelector('.ds-select-row__value').textContent).toBe('Beta');
    });

    test('puts a standalone number in a spin row and keeps its own validation', () => {
        const container = mount('<div class="flex1"><label for="query"><small>Query messages</small></label><input id="query" class="text_pole" type="number" min="1" max="99" value="2" step="0.5"></div>');
        const input = field(container, '#query');

        expect(normalizeExtensionSettings(container).numbers).toBe(1);

        const row = input.closest('.ds-row--spin');
        expect(row.querySelector('.ds-row-label').textContent).toBe('Query messages');
        expect(input.type).toBe('number');
        expect(input.getAttribute('min')).toBe('1');
        expect(input.value).toBe('2');
        // A fractional step asks for the decimal keypad.
        expect(input.inputMode).toBe('decimal');
        const seen = jest.fn();
        input.addEventListener('change', seen);
        row.querySelector('.ds-spin-btn--up').click();
        expect(input.value).toBe('2.5');
        expect(seen).toHaveBeenCalledTimes(1);
    });

    test('leaves a number that sits right beside another field, and says why', () => {
        const container = mount('<div class="flex-container"><label for="depth">Depth</label><input id="depth" type="number"><select id="role"><option>System</option></select></div>');
        const report = normalizeExtensionSettings(container);

        expect(report.numbers).toBe(0);
        expect(report.left).toContainEqual({ id: 'depth', type: 'spin', reason: 'beside other controls' });
        expect(field(container, '#depth').closest('.ds-row')).toBeNull();
    });

    test('leaves a slider counter and a control inside a label', () => {
        const container = mount('<div class="range-block"><div class="range-block-title"><small>Speed</small></div><div class="range-block-range-and-counter"><div class="range-block-counter"><input type="number" id="speed_counter" data-for="speed"></div></div></div><label><span>In-chat @ Depth</span> <input id="inline_depth" type="number"></label>');
        const report = normalizeExtensionSettings(container);

        expect(report.numbers).toBe(0);
        expect(report.left).toContainEqual({ id: 'inline_depth', type: 'spin', reason: 'inside a label' });
        expect(field(container, '#speed_counter').closest('.ds-row--spin')).toBeNull();
    });

    test('a select its extension shows and hides itself becomes a row that follows the select, titled by its tooltip', () => {
        const container = mount('<div><select id="deepl_api_endpoint" title="DeepL API Endpoint"><option value="free">Free</option></select></div>', 'translation_container');
        const report = normalizeExtensionSettings(container);

        expect(report.left).toEqual([]);
        expect(report.selects).toBe(1);
        const select = field(container, '#deepl_api_endpoint');
        const row = select.closest('.ds-select-row');
        expect(row.querySelector('.ds-row-label').textContent).toBe('DeepL API Endpoint');
        expect(row.hidden).toBe(false);

        select.style.display = 'none';
        return Promise.resolve().then(() => {
            expect(row.hidden).toBe(true);
            select.style.display = '';
            return Promise.resolve();
        }).then(() => {
            expect(row.hidden).toBe(false);
        });
    });

    test('opens a flex container of select rows and buttons into the group, and gives each button a row that follows its display', async () => {
        const container = mount(`
            <div class="ds-pref-group">
                <label for="translation_provider">Provider</label>
                <div class="flex-container gap5px flexnowrap">
                    <select id="translation_provider"><option value="deepl">DeepL API</option></select>
                    <select id="deepl_api_endpoint" title="DeepL API Endpoint"><option value="free">Free</option></select>
                    <div id="translate_key_button" class="menu_button menu_button_icon"><i class="fa-solid fa-key"></i><span>Key</span></div>
                    <div id="translate_url_button" class="menu_button menu_button_icon" style="display: none;"><i class="fa-solid fa-link"></i><span>URL</span></div>
                </div>
            </div>`, 'translation_container');
        normalizeExtensionSettings(container);

        const group = container.querySelector('.ds-pref-group');
        expect(group.querySelector('.flex-container')).toBeNull();
        expect([...group.children].filter(row => !row.matches('.sb-legacy-search-hidden')).map(row => row.className.includes('ds-select-row') ? 'select' : row.className.includes('ds-row-actions') ? 'button' : row.className)).toEqual(['select', 'select', 'button', 'button']);
        const key = field(container, '#translate_key_button');
        const url = field(container, '#translate_url_button');
        expect(key.closest('.ds-row-actions').parentElement).toBe(group);
        expect(key.closest('.ds-row-actions').querySelector('.ds-row-label').textContent).toBe('Key');
        expect(key.closest('.ds-row-actions').hidden).toBe(false);
        expect(url.closest('.ds-row-actions').hidden).toBe(true);

        url.style.display = '';
        await flush();
        expect(url.closest('.ds-row-actions').hidden).toBe(false);
    });

    test('reports a field that has no label and no placeholder, and leaves it as it was', () => {
        const container = mount('<div><select id="provider"><option>System</option></select></div>');
        const before = container.innerHTML;
        const report = normalizeExtensionSettings(container);

        expect(report.left).toEqual([{ id: 'provider', type: 'select', reason: 'no label or placeholder' }]);
        expect(container.innerHTML).toBe(before);
    });

    test('leaves a label that holds a link, which hiding it would hide too', () => {
        const container = mount('<div><label for="a">Key <a href="#" id="help" class="x">docs</a><span>more</span></label><input id="a" type="text"></div>');
        const report = normalizeExtensionSettings(container);

        expect(report.entries).toBe(0);
        expect(report.left).toEqual([{ id: 'a', type: 'entry', reason: 'its label holds a control or a link' }]);
    });

    test('leaves password, file and hidden inputs, and read-only text areas, to their own rows', () => {
        const container = mount('<div><label for="p">Key</label><input id="p" type="password"><label for="f">File</label><input id="f" type="file"><input id="h" type="hidden"><label for="t">Notes</label><textarea id="t" readonly></textarea></div>');
        const before = container.innerHTML;
        const report = normalizeExtensionSettings(container);

        expect(report).toMatchObject({ entries: 0, numbers: 0, selects: 0, textareas: 0, left: [] });
        expect(container.innerHTML).toBe(before);
    });

    test('is idempotent: a second pass finds nothing to do and changes nothing', () => {
        const container = mount(`
            <label class="checkbox_label" for="on" title="Turns it on"><input id="on" type="checkbox"><span>Enabled</span></label>
            <div><label for="addr">Address</label><input id="addr" type="text"></div>
            <div><label for="src">Source</label><select id="src"><option value="a">A</option></select></div>
            <div><label for="n"><small>Count</small></label><input id="n" type="number"></div>`);
        normalizeExtensionSettings(container);
        const html = container.innerHTML;

        const report = normalizeExtensionSettings(container);

        expect(report).toMatchObject({ entries: 0, numbers: 0, selects: 0 });
        expect(container.innerHTML).toBe(html);
    });

    test('adopts an input inside a form, as the provider settings of Text-to-speech are', () => {
        const container = mount('<form id="tts_provider_settings"><label for="url">Server URL</label><input id="url" type="text"></form>', 'tts_container');
        normalizeExtensionSettings(container);

        expect(field(container, '#url').closest('.ds-row-entry--floating').parentElement).toBe(container.querySelector('form'));
    });

    test('presents every labelled field of the provider settings, as a row inside the provider\'s own form', () => {
        const container = mount(`<form id="tts_provider_settings">
            <div><label for="url">Server URL</label><input id="url" type="text"></div>
            <div><label for="lang">Language</label><select id="lang"><option>en</option></select></div>
            <div><label for="n">Count</label><input id="n" type="number"></div>
            <label class="checkbox_label"><input id="stream" type="checkbox"><span>Stream</span></label>
            <div><label for="speed">Speed</label><input id="speed" type="range"></div></form>`, 'tts_container');
        const report = normalizeExtensionSettings(container);

        expect(report).toMatchObject({ entries: 1, selects: 1, numbers: 1 });
        expect(report.left).toEqual([]);
        expect(container.querySelector('#stream').closest('.ds-row-switch')).not.toBeNull();
        expect(container.querySelector('#speed').closest('.ds-row-slider')).not.toBeNull();
        expect(container.querySelector('form').contains(container.querySelector('#lang').closest('.ds-select-row'))).toBe(true);
    });
});

describe('switch rows', () => {
    test('turns checkbox labels into switch rows, with the tooltip as the subtitle and no copy placeholder', () => {
        const container = mount(`
            <label class="checkbox_label" for="a" title="Does the first thing"><input id="a" type="checkbox"><span>First</span></label>
            <label class="checkbox_label" for="b"><input id="b" type="checkbox"><small>Second</small></label>
            <label class="flex-container"><input id="c" type="checkbox"><span>Third</span></label>`);
        normalizeExtensionSettings(container);

        for (const id of ['a', 'b', 'c']) {
            const input = field(container, `#${id}`);
            expect(input.getAttribute('role')).toBe('switch');
            expect(input.closest('.ds-row-switch')).not.toBeNull();
        }
        expect(container.querySelector('label[for="a"] .ds-row-subtitle').textContent).toBe('Does the first thing');
        expect(container.querySelector('label[for="b"] .ds-row-subtitle')).toBeNull();
        expect(container.querySelector('[data-sb-copy-placeholder]')).toBeNull();
        expect(container.textContent).not.toContain('lorum ipsum');
    });

    test('leaves the areas an extension lays out from script', () => {
        const container = mount('<label class="flex-container"><input id="enabled" type="checkbox"><span>Enable</span></label><div id="qr--editor"><label class="flex-container"><input id="disable" type="checkbox"><span>Disable send</span></label><label for="name">Name</label><input id="name" type="text"></div>', 'qr_container');
        normalizeExtensionSettings(container);

        expect(field(container, '#enabled').closest('.ds-row-switch')).not.toBeNull();
        expect(field(container, '#disable').closest('.ds-row-switch')).toBeNull();
        expect(field(container, '#name').closest('.ds-row')).toBeNull();
    });
});

describe('a rebuild of the extension settings', () => {
    test('presents markup the extension adds later, and its own rows do not queue another pass', async () => {
        const container = mount('<div id="static"><label for="first">First</label><input id="first" type="text"></div><form id="provider"></form>', 'tts_container');
        watchExtensionSettings(container);
        expect(field(container, '#first').closest('.ds-row-entry--floating')).not.toBeNull();

        container.querySelector('#provider').innerHTML = '<label for="key">API key</label><input id="key" type="text"><label class="checkbox_label"><input id="stream" type="checkbox"><span>Stream</span></label>';
        await flush();

        expect(titleOf(field(container, '#key'))).toBe('API key');
        expect(field(container, '#stream').closest('.ds-row-switch')).not.toBeNull();
        const html = container.innerHTML;
        await flush();
        expect(container.innerHTML).toBe(html);

        // A second rebuild is presented the same way.
        container.querySelector('#provider').innerHTML = '<label for="voice">Voice</label><input id="voice" type="text">';
        await flush();
        expect(titleOf(field(container, '#voice'))).toBe('Voice');
    });

    test('watching a page twice installs one observer', async () => {
        const container = mount('<div></div>', 'tts_container');
        const observe = jest.spyOn(MutationObserver.prototype, 'observe');
        watchExtensionSettings(container);
        watchExtensionSettings(container);

        expect(observe).toHaveBeenCalledTimes(1);
        observe.mockRestore();
    });

    test('ignores changes that add no element', async () => {
        const container = mount('<div id="note">text</div>', 'tts_container');
        watchExtensionSettings(container);
        container.querySelector('#note').firstChild.nodeValue = 'changed';
        container.querySelector('#note').append(document.createTextNode(' more'));
        await flush();

        expect(container.querySelector('.ds-row')).toBeNull();
    });
});

describe('third-party extension settings', () => {
    const markup = '<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>Some Extension</b></div><div class="inline-drawer-content" style="display: block"><label class="checkbox_label" for="tp_on"><input id="tp_on" type="checkbox"><span>On</span></label><div><label for="tp_url">URL</label><input id="tp_url" class="text_pole" type="text" placeholder="x"></div><div><label for="tp_mode">Mode</label><select id="tp_mode"><option>a</option></select></div><div><label for="tp_n">N</label><input id="tp_n" type="number"></div></div></div>';

    test('keep their markup when the detail page is presented without the built-in flag', () => {
        const container = mount(markup, 'qa-third-party-container');
        const before = container.querySelector('.inline-drawer-content').innerHTML;

        normalizeSettingsDetail(container, { name: 'extensions', rowLabel: 'Some Extension', builtIn: false });
        normalizeSettingsDetail(container, { name: 'extensions', rowLabel: 'Some Extension' });

        expect(container.querySelector('.ds-row-switch, .ds-row-entry--floating, .ds-select-row, .ds-row--spin')).toBeNull();
        expect(container.querySelector('#tp_on').hasAttribute('role')).toBe(false);
        expect(container.querySelector('[data-sb-adopted-label]')).toBeNull();
        expect(container.querySelector('#tp_url').getAttribute('placeholder')).toBe('x');
        // The page's own card pass may group rows; the controls inside keep the markup they were authored with.
        expect(container.querySelector('.inline-drawer-content').innerHTML).toBe(before);
    });

    test('are not watched, so markup the extension adds later is not touched either', async () => {
        const container = mount(markup, 'qa-third-party-container');
        normalizeSettingsDetail(container, { name: 'extensions', rowLabel: 'Some Extension', builtIn: false });
        container.querySelector('.inline-drawer-content').insertAdjacentHTML('beforeend', '<div><label for="late">Late</label><input id="late" type="text"></div>');
        await flush();

        expect(container.querySelector('#late').closest('.ds-row')).toBeNull();
    });

    test('the same markup is presented when the page is a built-in one', () => {
        const container = mount(markup, 'vectors_container');
        normalizeSettingsDetail(container, { name: 'extensions', rowLabel: 'Some Extension', builtIn: true });

        expect(container.querySelector('#tp_on').closest('.ds-row-switch')).not.toBeNull();
        expect(container.querySelector('#tp_url').closest('.ds-row-entry--floating')).not.toBeNull();
        expect(container.querySelector('#tp_mode').closest('.ds-select-row')).not.toBeNull();
        expect(container.querySelector('#tp_n').closest('.ds-row--spin')).not.toBeNull();
    });

    test('are not built-in: only the listed containers are, and Bunny Preset Tools, Chat Completion Tabs and Quick Image Gen are not', () => {
        const drawer = title => `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>${title}</b></div><div class="inline-drawer-content"><input type="checkbox"></div></div>`;
        const ids = ['vectors_container', 'tts_container', 'sd_container', 'bpt-settings', 'ChatCompletionTabs-container', 'qig-settings', 'rvc_container', 'qa-third-party'];
        document.body.innerHTML = `<div id="panel"><div id="rm_extensions_block"><div class="extensions_block"><div id="extensions_settings">${ids.map(id => `<div id="${id}" class="extension_container">${drawer(id)}</div>`).join('')}</div></div></div></div>`;

        const { rows } = buildExtensionsSubpage(document.getElementById('panel'));

        const flags = Object.fromEntries(rows.map(row => [row.id, row.builtIn]));
        expect(flags).toEqual({
            vectors_container: true,
            tts_container: true,
            sd_container: true,
            'bpt-settings': false,
            'ChatCompletionTabs-container': false,
            'qig-settings': false,
            rvc_container: false,
            'qa-third-party': false,
        });
        for (const id of ['bpt-settings', 'ChatCompletionTabs-container', 'qig-settings', 'qa-third-party']) expect(isBuiltInExtensionContainer(id)).toBe(false);
    });

    test('reach the presentation pass only through the row flag that the Extensions page passes', () => {
        const calls = tabs.match(/normalizeSettingsDetail\([^)]*\)/g) ?? [];
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('builtIn: row.builtIn === true');
        expect(tabs.match(/watchExtensionSettings|normalizeExtensionSettings/g)).toBeNull();
    });
});
