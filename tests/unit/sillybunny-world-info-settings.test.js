/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions inspect synchronous controls and event delivery. */
import { readFileSync } from 'node:fs';
import { jest, beforeEach, afterEach, describe, expect, test } from '@jest/globals';

const worldNames = [];
const settingsListeners = new Set();
const eventTypes = { WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated' };
const eventSource = {
    on: jest.fn((_type, handler) => settingsListeners.add(handler)),
    removeListener: jest.fn((_type, handler) => settingsListeners.delete(handler)),
    emit: jest.fn(() => settingsListeners.forEach(handler => handler())),
};

await jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({ world_names: worldNames }));
await jest.unstable_mockModule('../../public/scripts/events.js', () => ({ eventSource, event_types: eventTypes }));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));

const { mountWorldInfoSettings } = await import('../../public/scripts/sillybunny-world-info-settings.js');
const indexHtml = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const legacyHtml = indexHtml.slice(indexHtml.indexOf('<div id="wiTopBlock"'), indexHtml.indexOf('<div id="world_popup">'));
const sliderIds = [
    'world_info_depth',
    'world_info_budget',
    'world_info_budget_cap',
    'world_info_min_activations',
    'world_info_min_activations_depth_max',
    'world_info_max_recursion_steps',
];
const switchIds = [
    'world_info_include_names',
    'world_info_recursive',
    'world_info_case_sensitive',
    'world_info_match_whole_words',
    'world_info_use_group_scoring',
    'world_info_overflow_alert',
];
const movedIds = [...sliderIds.flatMap(id => [id, `${id}_counter`]), 'world_info_character_strategy', ...switchIds];
let controller;
let host;
let legacy;
let select;
let onClose;

function control(id) {
    return document.getElementById(id);
}

function row(id) {
    return host.querySelector(`[data-sb-editor-field="${id}"]`);
}

function book(index) {
    return host.querySelector(`.sb-wi-settings-book[data-world-index="${index}"] input`);
}

function mount() {
    controller = mountWorldInfoSettings({ host, onClose });
    return controller;
}

function change(target, type = 'change') {
    target.dispatchEvent(new Event(type, { bubbles: true }));
}

function setBooks(names, selected = []) {
    worldNames.splice(0, worldNames.length, ...names);
    select.replaceChildren(...names.map((name, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = name;
        option.selected = selected.includes(index);
        return option;
    }));
}

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    jest.clearAllMocks();
    settingsListeners.clear();
    document.body.innerHTML = `<div id="legacy">${legacyHtml}</div><div id="sb-settings-page"><div class="sb-settings-mounted-shell"><div class="sb-list-editor sb-wi-editor" data-collapsed="false"><div id="detail"></div></div></div></div>`;
    legacy = control('legacy');
    host = control('detail');
    select = control('world_info');
    onClose = jest.fn();
    setBooks(['Alpha', 'Beta', 'Gamma'], [1]);
    for (const id of sliderIds) {
        control(id).value = id === 'world_info_budget' ? '25' : '0';
        control(`${id}_counter`).value = control(id).value;
    }
});

afterEach(() => {
    controller?.destroy();
    controller = null;
    document.body.replaceChildren();
    jest.useRealTimers();
});

describe('World Info settings transport adoption', () => {
    test('reparents every original control with its ID and restores the complete legacy markup twice', () => {
        control('world_info_case_sensitive').setAttribute('aria-describedby', 'old-description');
        control('world_info_case_sensitive').classList.add('original-class');
        control('world_info_depth').disabled = true;
        const originalHtml = legacy.innerHTML;
        const originals = movedIds.map(id => ({ node: control(id), parent: control(id).parentNode, next: control(id).nextSibling }));

        for (let iteration = 0; iteration < 2; iteration++) {
            mount();
            for (const { node } of originals) {
                expect(host.contains(node)).toBe(true);
                expect(control(node.id)).toBe(node);
                expect(document.querySelectorAll(`[id="${node.id}"]`)).toHaveLength(1);
            }
            expect(legacy.contains(select)).toBe(true);
            expect(host.contains(select)).toBe(false);
            controller.destroy();
            for (const { node, parent, next } of originals) {
                expect(node.parentNode).toBe(parent);
                expect(node.nextSibling).toBe(next);
            }
            expect(legacy.innerHTML).toBe(originalHtml);
            expect(host.childNodes).toHaveLength(0);
        }
    });

    test('the original range handler still receives input and updates the original paired counter', () => {
        const range = control('world_info_depth');
        const counter = control('world_info_depth_counter');
        const handler = jest.fn(() => { counter.value = range.value; });
        range.addEventListener('input', handler);
        mount();
        range.value = '37';
        change(range, 'input');
        expect(handler).toHaveBeenCalledTimes(1);
        expect(counter.value).toBe('37');
        expect(range.closest('.ds-row-slider')).toBe(counter.closest('.ds-row-slider'));
        expect([...range.parentElement.children]).toEqual([range, counter]);
        controller.destroy();
        expect(range.value).toBe('37');
        expect(counter.value).toBe('37');
    });

    test('counter classes, constraints and data-for remain available to the global neo-range handler', () => {
        mount();
        for (const id of sliderIds) {
            const range = control(id);
            const counter = control(`${id}_counter`);
            expect(counter.classList.contains('neo-range-input')).toBe(true);
            expect(counter.dataset.for).toBe(id);
            expect([counter.min, counter.max, counter.step]).toEqual([range.min, range.max, range.step]);
            expect(counter.getAttribute('aria-labelledby')).toBe(range.getAttribute('aria-labelledby'));
            expect(control(counter.getAttribute('aria-labelledby')).textContent).not.toBe('');
        }
    });

    test('original checkbox and strategy handlers keep their native events', () => {
        const checkbox = control('world_info_include_names');
        const strategy = control('world_info_character_strategy');
        const inputHandler = jest.fn();
        const changeHandler = jest.fn();
        checkbox.addEventListener('input', inputHandler);
        strategy.addEventListener('change', changeHandler);
        mount();
        checkbox.click();
        strategy.value = '2';
        change(strategy);
        expect(inputHandler).toHaveBeenCalledTimes(1);
        expect(changeHandler).toHaveBeenCalledTimes(1);
        expect(checkbox.getAttribute('aria-checked')).toBe('true');
        expect(strategy.options).toHaveLength(3);
    });

    test('missing controls fail before any legacy node moves', () => {
        control('world_info_overflow_alert').remove();
        const originalHtml = legacy.innerHTML;
        expect(() => mount()).toThrow('world_info_overflow_alert');
        expect(legacy.innerHTML).toBe(originalHtml);
        expect(host.children).toHaveLength(0);
    });

    test('mount requires an empty host and a close callback', () => {
        expect(() => mountWorldInfoSettings({ host, onClose: null })).toThrow('onClose');
        host.append(document.createTextNode('occupied'));
        expect(() => mount()).toThrow('empty host');
    });
});

describe('settings pane structure and lifecycle', () => {
    test('uses the shared detail header/back hook, scroll body and existing preference headings', () => {
        mount();
        const root = host.querySelector('.sb-wi-settings');
        const header = root.firstElementChild;
        expect(header.tagName).toBe('HEADER');
        expect(header.classList.contains('sb-wi-detail-header')).toBe(true);
        expect(header.querySelector('button.sb-wi-detail-back').classList.contains('sb-list-editor__back')).toBe(false);
        expect(header.querySelector('h2').textContent).toBe('Global Settings');
        expect(root.lastElementChild.classList.contains('sb-wi-settings-body')).toBe(true);
        expect([...root.querySelectorAll('.ds-pref-group-heading')].map(heading => heading.textContent)).toEqual([
            'Active World(s) for all chats',
            'Global World Info/Lorebook activation settings',
        ]);
        expect(root.querySelectorAll('.ds-row-slider')).toHaveLength(6);
        expect(controller.focusTarget()).toBe(root.querySelector('input[type="search"]'));
        header.querySelector('button').click();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('Escape blurs a field or returns to the list without closing the surrounding settings page', () => {
        mount();
        const outerEscape = jest.fn();
        control('sb-settings-page').addEventListener('keydown', outerEscape);
        const search = controller.focusTarget();
        search.focus();
        search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(document.activeElement).not.toBe(search);
        expect(onClose).not.toHaveBeenCalled();
        host.querySelector('.sb-wi-settings-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(outerEscape).not.toHaveBeenCalled();
    });

    test('destroy is idempotent and removes all transport, event-bus and detached-control listeners', async () => {
        mount();
        const range = control('world_info_min_activations');
        const oldRow = range.closest('.ds-row');
        const oldBook = book(0);
        const legacySwitch = control('world_info_recursive');
        const search = controller.focusTarget();
        const refresh = eventSource.on.mock.calls[0][1];
        const back = host.querySelector('.sb-wi-detail-back');
        controller.destroy();
        controller.destroy();
        expect(eventSource.removeListener).toHaveBeenCalledTimes(1);
        expect(eventSource.removeListener).toHaveBeenCalledWith(eventTypes.WORLDINFO_SETTINGS_UPDATED, refresh);
        expect(settingsListeners.size).toBe(0);
        expect(controller.focusTarget()).toBeNull();
        expect(legacySwitch.hasAttribute('aria-checked')).toBe(false);
        legacySwitch.click();
        expect(legacySwitch.hasAttribute('aria-checked')).toBe(false);
        range.value = '4';
        change(range, 'input');
        expect(oldRow.dataset.disabledBy).toBe('');
        oldBook.click();
        expect(select.options[0].selected).toBe(false);
        back.click();
        expect(onClose).not.toHaveBeenCalled();
        search.value = 'missing';
        change(search, 'input');
        expect(oldBook.closest('.ds-row').hidden).toBe(false);
        setBooks(['Changed']);
        await Promise.resolve();
        expect(oldBook.closest('.ds-row').isConnected).toBe(false);
    });
});

describe('mutually exclusive activation settings', () => {
    test('minimum activations makes recursion insensitive with the disabling source in its subtitle', () => {
        control('world_info_min_activations').value = '3';
        mount();
        expect(control('world_info_max_recursion_steps').disabled).toBe(true);
        expect(control('world_info_max_recursion_steps_counter').disabled).toBe(true);
        expect(row('world_info_max_recursion_steps').classList.contains('is-insensitive')).toBe(true);
        expect(row('world_info_max_recursion_steps').dataset.disabledBy).toBe('world_info_min_activations');
        expect(row('world_info_max_recursion_steps').querySelector('.ds-row-subtitle').textContent).toContain('Min Activations → Disabled');
        expect(control('world_info_min_activations').disabled).toBe(false);
        control('world_info_min_activations').value = '0';
        change(control('world_info_min_activations'), 'input');
        expect(control('world_info_max_recursion_steps').disabled).toBe(false);
        expect(row('world_info_max_recursion_steps').querySelector('.ds-row-subtitle').textContent).not.toContain('Min Activations → Disabled');
    });

    test('recursion disables minimum activations and updates after legacy settings notifications', () => {
        mount();
        control('world_info_max_recursion_steps').value = '2';
        eventSource.emit(eventTypes.WORLDINFO_SETTINGS_UPDATED);
        expect(control('world_info_min_activations').disabled).toBe(true);
        expect(control('world_info_min_activations_counter').disabled).toBe(true);
        expect(row('world_info_min_activations').querySelector('.ds-row-subtitle').textContent).toContain('(disabled when max recursion steps are used)');
        control('world_info_max_recursion_steps').value = '0';
        change(control('world_info_max_recursion_steps'), 'input');
        expect(control('world_info_min_activations').disabled).toBe(false);
    });

    test('conflicting imported values remain editable without changing persisted slider values', () => {
        control('world_info_min_activations').value = '3';
        control('world_info_max_recursion_steps').value = '2';
        mount();
        expect(control('world_info_min_activations').disabled).toBe(false);
        expect(control('world_info_max_recursion_steps').disabled).toBe(true);
        expect(control('world_info_min_activations').value).toBe('3');
        expect(control('world_info_max_recursion_steps').value).toBe('2');
        controller.destroy();
        expect(control('world_info_max_recursion_steps').disabled).toBe(false);
    });
});

describe('active books', () => {
    test('search waits for a 300ms pause, clears immediately and drops pending work on destroy', async () => {
        mount();
        await Promise.resolve();
        const search = controller.focusTarget();
        const firstRow = book(0).closest('.ds-row');
        const observer = new MutationObserver(() => {});
        observer.observe(firstRow, { attributes: true });
        search.value = 'a';
        change(search, 'input');
        jest.advanceTimersByTime(200);
        search.value = 'Beta';
        change(search, 'input');
        jest.advanceTimersByTime(299);
        expect(observer.takeRecords()).toHaveLength(0);
        jest.advanceTimersByTime(1);
        expect(firstRow.hidden).toBe(true);
        search.value = 'missing';
        change(search, 'input');
        search.value = '';
        change(search, 'input');
        expect(firstRow.hidden).toBe(false);
        observer.takeRecords();
        jest.advanceTimersByTime(300);
        expect(observer.takeRecords()).toHaveLength(0);
        search.value = 'missing';
        change(search, 'input');
        controller.destroy();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(300);
        expect(firstRow.hidden).toBe(false);
        observer.disconnect();
    });

    test('reflects option.selected rather than its default selected attribute', () => {
        select.options[0].setAttribute('selected', '');
        select.options[0].selected = false;
        select.options[2].selected = true;
        mount();
        expect([book(0).checked, book(1).checked, book(2).checked]).toEqual([false, true, true]);
    });

    test('a switch writes selected and dispatches one bubbling change on the original select', () => {
        const selectChange = jest.fn();
        const bubblingChange = jest.fn();
        select.addEventListener('change', selectChange);
        legacy.addEventListener('change', bubblingChange);
        mount();
        const first = book(0);
        first.focus();
        first.click();
        expect(select.options[0].selected).toBe(true);
        expect(select.options[1].selected).toBe(true);
        expect(selectChange).toHaveBeenCalledTimes(1);
        expect(bubblingChange).toHaveBeenCalledTimes(1);
        expect(selectChange.mock.calls[0][0].bubbles).toBe(true);
        expect(document.activeElement).toBe(first);
        expect(book(0)).toBe(first);
        first.click();
        expect(select.options[0].selected).toBe(false);
        expect(selectChange).toHaveBeenCalledTimes(2);
    });

    test('external selection and hydration notifications refresh checked and ARIA state without change writes', () => {
        mount();
        const onChange = jest.fn();
        select.addEventListener('change', onChange);
        select.options[0].selected = true;
        select.options[1].selected = false;
        eventSource.emit(eventTypes.WORLDINFO_SETTINGS_UPDATED);
        expect(book(0).checked).toBe(true);
        expect(book(0).getAttribute('aria-checked')).toBe('true');
        expect(book(1).checked).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
        select.options[2].selected = true;
        change(select);
        expect(book(2).checked).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('search filters book names case-insensitively, provides no-results state and retains selections', () => {
        mount();
        const search = controller.focusTarget();
        search.value = '  bEt  ';
        change(search, 'input');
        jest.advanceTimersByTime(300);
        expect(book(0).closest('.ds-row').hidden).toBe(true);
        expect(book(1).closest('.ds-row').hidden).toBe(false);
        expect(book(2).closest('.ds-row').hidden).toBe(true);
        expect(book(1).checked).toBe(true);
        search.value = 'missing';
        change(search, 'input');
        jest.advanceTimersByTime(300);
        expect(host.querySelector('.sb-wi-settings-empty').hidden).toBe(false);
        expect(host.querySelector('.sb-wi-settings-empty .sb-status-page__title').textContent).toBe('No results');
        search.value = '';
        change(search, 'input');
        expect(host.querySelectorAll('.sb-wi-settings-book:not([hidden])')).toHaveLength(3);
        expect(host.querySelector('.sb-wi-settings-empty').hidden).toBe(true);
        expect(select.options[1].selected).toBe(true);
    });

    test('replaced options and book names refresh through MutationObserver and preserve the current search', async () => {
        mount();
        const search = controller.focusTarget();
        search.value = 'delta';
        change(search, 'input');
        setBooks(['Delta', 'Epsilon'], [0]);
        await Promise.resolve();
        expect(host.querySelectorAll('.sb-wi-settings-book')).toHaveLength(2);
        expect(book(0).closest('.ds-row').querySelector('.ds-row-label').textContent).toBe('Delta');
        expect(book(0).checked).toBe(true);
        expect(book(0).closest('.ds-row').hidden).toBe(false);
        expect(book(1).closest('.ds-row').hidden).toBe(true);
        expect(search.value).toBe('delta');
    });

    test('selected attribute mutations refresh the list without a change event', async () => {
        const pristine = document.createElement('option');
        pristine.value = '0';
        pristine.textContent = 'Alpha';
        select.options[0].replaceWith(pristine);
        mount();
        pristine.setAttribute('selected', '');
        await Promise.resolve();
        expect(book(0).checked).toBe(true);
    });

    test('empty books use the existing no-world status and become available after options arrive', async () => {
        setBooks([]);
        mount();
        expect(host.querySelectorAll('.sb-wi-settings-book')).toHaveLength(0);
        expect(host.querySelector('.sb-wi-settings-empty .sb-status-page__title').textContent).toBe('-- World Info not found --');
        expect(host.querySelector('.sb-wi-settings-empty').hidden).toBe(false);
        setBooks(['New book'], [0]);
        await Promise.resolve();
        expect(book(0).checked).toBe(true);
        expect(host.querySelector('.sb-wi-settings-empty').hidden).toBe(true);
    });

    test('disabled transport options cannot be toggled and untrusted book names stay text', () => {
        const name = '<img src=x onerror=alert(1)>';
        setBooks([name]);
        select.options[0].disabled = true;
        mount();
        expect(book(0).disabled).toBe(true);
        expect(book(0).closest('.ds-row').querySelector('.ds-row-label').textContent).toBe(name);
        expect(host.querySelector('img')).toBeNull();
        book(0).click();
        expect(select.options[0].selected).toBe(false);
    });
});
