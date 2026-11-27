/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { foldSearchText } from '../../public/scripts/sillybunny-settings-search.js';
import { unwatchToastButtons, watchToastButtons } from '../../public/scripts/sillybunny-toast-form.js';
import { unwatchButtons, watchButtons } from '../../public/scripts/sillybunny-toast-notification.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRepoFile = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8').replace(/\r\n/g, '\n');

const flushMicrotasks = async () => {
    for (let index = 0; index < 4; index++) {
        await Promise.resolve();
    }
};

afterEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
    jest.restoreAllMocks();
});

describe('Slice 1B observer scoping and leak fixes', () => {
    test('toast and notification button watchers disconnect their MutationObservers on cleanup', async () => {
        const toast = document.createElement('div');
        toast.innerHTML = '<div class="toast-message">Saved</div>';
        document.body.append(toast);

        const stopToast = watchToastButtons(toast);
        const button = document.createElement('button');
        button.textContent = 'Undo';
        toast.querySelector('.toast-message').append(button);
        await flushMicrotasks();
        expect(toast.classList.contains('sb-toast--button')).toBe(true);

        stopToast();
        toast.classList.remove('sb-toast--button');
        const secondButton = document.createElement('button');
        secondButton.textContent = 'Retry';
        toast.querySelector('.toast-message').append(secondButton);
        await flushMicrotasks();
        expect(toast.classList.contains('sb-toast--button')).toBe(false);
        unwatchToastButtons(toast);

        const notification = document.createElement('div');
        notification.innerHTML = '<div class="toast-message">Notice</div>';
        document.body.append(notification);
        const stopNotification = watchButtons(notification);
        const action = document.createElement('button');
        action.textContent = 'Open';
        notification.querySelector('.toast-message').append(action);
        await flushMicrotasks();
        expect(notification.querySelector('.sb-toast-actions')).not.toBeNull();

        stopNotification();
        notification.querySelector('.sb-toast-actions')?.remove();
        const laterAction = document.createElement('button');
        laterAction.textContent = 'Later';
        notification.querySelector('.toast-message').append(laterAction);
        await flushMicrotasks();
        expect(notification.querySelector('.sb-toast-actions')).toBeNull();
        unwatchButtons(notification);
    });

    test('keyboard.js skips descendant scans on unrelated class toggles and rescans when disabled changes', async () => {
        globalThis.CSS = { supports: () => false };
        const { initKeyboard } = await import('../../public/scripts/keyboard.js');
        initKeyboard();

        const container = document.createElement('div');
        const control = document.createElement('div');
        control.className = 'menu_button';
        container.append(control);
        document.body.append(container);
        await flushMicrotasks();
        expect(control.getAttribute('tabindex')).toBe('0');

        const querySpy = jest.spyOn(container, 'querySelectorAll');
        container.classList.add('unrelated-visual-state');
        await flushMicrotasks();
        expect(querySpy).not.toHaveBeenCalled();

        container.classList.add('disabled');
        await flushMicrotasks();
        expect(querySpy).toHaveBeenCalledTimes(2);
        expect(control.hasAttribute('tabindex')).toBe(false);

        container.classList.remove('disabled');
        await flushMicrotasks();
        expect(control.getAttribute('tabindex')).toBe('0');
    });

    test('a11y.js avoids descendant querySelectorAll on added leaf elements while still tagging matching controls', async () => {
        const { initAccessibility } = await import('../../public/scripts/a11y.js');
        initAccessibility();

        const leaf = document.createElement('span');
        leaf.textContent = 'Streaming token';
        const leafQuerySpy = jest.spyOn(leaf, 'querySelectorAll');
        document.body.append(leaf);
        await flushMicrotasks();
        expect(leafQuerySpy).not.toHaveBeenCalled();
        expect(leaf.getAttribute('role')).toBeNull();

        const button = document.createElement('div');
        button.className = 'menu_button';
        const buttonQuerySpy = jest.spyOn(button, 'querySelectorAll');
        document.body.append(button);
        await flushMicrotasks();
        expect(buttonQuerySpy).not.toHaveBeenCalled();
        expect(button.getAttribute('role')).toBe('button');
    });

    test('extension actions do not observe document.body and message actions omit legacy delete-count observer', () => {
        const extActions = readRepoFile('public', 'scripts', 'sillybunny-extension-actions.js');
        const msgActions = readRepoFile('public', 'scripts', 'sillybunny-message-actions.js');
        const tabsJs = readRepoFile('public', 'scripts', 'sillybunny-tabs.js');

        expect(extActions).not.toContain('rowObserver.observe(document.body');
        expect(extActions).toContain('rowObserver.observe(container');
        expect(msgActions).not.toContain('initializeDeleteCount');
        expect(tabsJs).toContain('if (isActive) tabState.searchIndex = null;');
        expect(tabsJs).toContain('ensureClassicScrollbarsSynced();');
    });

    test('foldSearchText ASCII fast path matches Unicode folding semantics', () => {
        expect(foldSearchText('Avatar Settings 123')).toBe('avatar settings 123');
        expect(foldSearchText('Résumé Écran')).toBe('resume ecran');
        expect(foldSearchText('İstanbul ǅ ﬁ')).toHaveLength('İstanbul ǅ ﬁ'.length);
    });
});
