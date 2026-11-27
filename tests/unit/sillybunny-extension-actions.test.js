/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ openActionMenu: jest.fn() }));
const { unobserveRemovedRows } = await import('../../public/scripts/sillybunny-extension-actions.js');

const flushMicrotasks = async () => {
    for (let index = 0; index < 4; index++) {
        await Promise.resolve();
    }
};

let originalMatchMedia;

beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    window.matchMedia = jest.fn(() => ({
        matches: true,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
    }));
});

afterEach(() => {
    document.dispatchEvent(new CustomEvent('sillybunny:extensions-manager-close'));
    document.body.replaceChildren();
    window.matchMedia = originalMatchMedia;
    jest.restoreAllMocks();
});

test('unobserves extension rows removed with a manager subtree', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="extensions_info"><div class="extension_block"><div class="extension_block"></div></div></div>';
    const observer = { unobserve: jest.fn() };
    const removed = root.querySelector('.extension_block');

    unobserveRemovedRows(removed, observer);

    expect(observer.unobserve).toHaveBeenCalledTimes(2);
    expect(observer.unobserve).toHaveBeenNthCalledWith(1, removed);
    expect(observer.unobserve).toHaveBeenNthCalledWith(2, removed.firstElementChild);
});

test('ignores unrelated <small class="extensions_info"> elements earlier in the DOM and observes div.extensions_info', async () => {
    document.body.innerHTML = `
        <small class="flex-container extensions_info">Regex help text</small>
        <div class="extensions_info">
            <div class="extension_block" id="ext-row-1">
                <div class="extension_actions">
                    <button type="button" title="Update"><i class="fa-solid fa-rotate"></i></button>
                </div>
            </div>
        </div>
    `;

    document.dispatchEvent(new CustomEvent('sillybunny:extensions-manager-open'));

    const firstRow = document.getElementById('ext-row-1');
    expect(firstRow.classList.contains('sb-extension-actions-collapsed')).toBe(true);
    expect(firstRow.querySelector('.sb-extension-actions-menu')).not.toBeNull();

    // Newly added rows inside div.extensions_info must also be observed and collapsed.
    const secondRow = document.createElement('div');
    secondRow.className = 'extension_block';
    secondRow.innerHTML = '<div class="extension_actions"><button type="button" title="Delete"></button></div>';
    document.querySelector('div.extensions_info').append(secondRow);
    await flushMicrotasks();

    expect(secondRow.classList.contains('sb-extension-actions-collapsed')).toBe(true);
    expect(secondRow.querySelector('.sb-extension-actions-menu')).not.toBeNull();
});

test('binds to the container provided in sillybunny:extensions-manager-open detail and ignores unrelated close events', async () => {
    const firstManager = document.createElement('div');
    firstManager.className = 'extensions_info';
    firstManager.innerHTML = '<div class="extension_block"><div class="extension_actions"><button type="button" title="One"></button></div></div>';

    const secondManager = document.createElement('div');
    secondManager.className = 'extensions_info';
    secondManager.innerHTML = '<div class="extension_block" id="target-row"><div class="extension_actions"><button type="button" title="Two"></button></div></div>';

    document.body.append(firstManager, secondManager);
    document.dispatchEvent(new CustomEvent('sillybunny:extensions-manager-open', { detail: { container: secondManager } }));

    expect(firstManager.querySelector('.sb-extension-actions-menu')).toBeNull();
    expect(document.getElementById('target-row').classList.contains('sb-extension-actions-collapsed')).toBe(true);

    // Closing a different container must not disconnect the active manager's observer.
    document.dispatchEvent(new CustomEvent('sillybunny:extensions-manager-close', { detail: { container: firstManager } }));
    const appendedRow = document.createElement('div');
    appendedRow.className = 'extension_block';
    appendedRow.innerHTML = '<div class="extension_actions"><button type="button" title="Three"></button></div>';
    secondManager.append(appendedRow);
    await flushMicrotasks();

    expect(appendedRow.classList.contains('sb-extension-actions-collapsed')).toBe(true);

    // Closing the active container disconnects its observer.
    document.dispatchEvent(new CustomEvent('sillybunny:extensions-manager-close', { detail: { container: secondManager } }));
    const afterCloseRow = document.createElement('div');
    afterCloseRow.className = 'extension_block';
    afterCloseRow.innerHTML = '<div class="extension_actions"><button type="button" title="Four"></button></div>';
    secondManager.append(afterCloseRow);
    await flushMicrotasks();

    expect(afterCloseRow.classList.contains('sb-extension-actions-collapsed')).toBe(false);
});
