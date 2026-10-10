import { expect, test } from '@playwright/test';
import { testSetup } from './frontend/frontent-test-utils.js';

test.describe('keyboard interactables', () => {
    test.beforeEach(async ({ page }) => {
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
        // Count focusout registrations per element so repeated bindings are visible.
        await page.addInitScript(() => {
            window.__focusoutListenerCounts = new WeakMap();
            const addEventListener = EventTarget.prototype.addEventListener;
            EventTarget.prototype.addEventListener = function (type, listener, options) {
                if (type === 'focusout') {
                    window.__focusoutListenerCounts.set(this, (window.__focusoutListenerCounts.get(this) ?? 0) + 1);
                }
                return addEventListener.call(this, type, listener, options);
            };
        });
        await testSetup.awaitST({ page });
    });

    test('restores the original tabindex after a container is disabled and enabled again', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const host = document.createElement('div');
            host.innerHTML = '<div class="menu_button" tabindex="3">custom</div><div class="menu_button">default</div>';
            document.body.appendChild(host);
            await sleep(50);
            const controls = [...host.children];
            const initial = controls.map(control => control.getAttribute('tabindex'));

            host.classList.add('disabled');
            await sleep(50);
            // Further class changes on the container rescan its controls while they are disabled.
            host.classList.add('sb-keyboard-test');
            await sleep(50);
            host.classList.remove('sb-keyboard-test');
            await sleep(50);
            const whileDisabled = controls.map(control => ({
                tabindex: control.getAttribute('tabindex'),
                stashed: control.getAttribute('data-original-tabindex'),
            }));

            host.classList.remove('disabled');
            await sleep(50);
            const enabled = controls.map(control => {
                control.focus();
                const state = { tabindex: control.getAttribute('tabindex'), focused: document.activeElement === control };
                control.blur();
                return state;
            });
            host.remove();

            return {
                initial,
                whileDisabled,
                enabled,
                nullStashesOnPage: document.querySelectorAll('[data-original-tabindex="null"]').length,
            };
        });

        expect(result.initial).toEqual(['3', '0']);
        expect(result.whileDisabled).toEqual([{ tabindex: null, stashed: '3' }, { tabindex: null, stashed: '0' }]);
        expect(result.enabled).toEqual([{ tabindex: '3', focused: true }, { tabindex: '0', focused: true }]);
        expect(result.nullStashesOnPage).toBe(0);
    });

    test('makes a control that started out disabled focusable once enabled', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const host = document.createElement('div');
            host.className = 'disabled';
            host.innerHTML = '<div class="menu_button">late</div>';
            document.body.appendChild(host);
            await sleep(50);
            const control = host.firstElementChild;
            const whileDisabled = control.getAttribute('data-original-tabindex');

            host.classList.remove('disabled');
            await sleep(50);
            control.focus();
            const state = { whileDisabled, tabindex: control.getAttribute('tabindex'), focused: document.activeElement === control };
            host.remove();
            return state;
        });

        expect(result).toEqual({ whileDisabled: null, tabindex: '0', focused: true });
    });

    test('binds the scroll reset to a container once and still resets on blur', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const wrapper = document.createElement('div');
            wrapper.innerHTML = '<div class="scroll-reset-container" style="overflow: auto; height: 40px; width: 200px;"><div style="height: 400px;"><button class="inside">inside</button></div></div><button class="outside">outside</button>';
            document.body.appendChild(wrapper);
            await sleep(50);
            for (let i = 0; i < 5; i++) {
                wrapper.classList.toggle('sb-keyboard-test');
                await sleep(20);
            }

            const container = wrapper.querySelector('.scroll-reset-container');
            const listeners = window.__focusoutListenerCounts.get(container) ?? 0;
            wrapper.querySelector('.inside').focus();
            container.scrollTop = 120;
            const scrolled = container.scrollTop;
            wrapper.querySelector('.outside').focus();
            await sleep(50);
            const afterBlur = container.scrollTop;
            wrapper.remove();
            return { listeners, scrolled, afterBlur };
        });

        expect(result.listeners).toBe(1);
        expect(result.scrolled).toBeGreaterThan(0);
        expect(result.afterBlur).toBe(0);
    });
});
