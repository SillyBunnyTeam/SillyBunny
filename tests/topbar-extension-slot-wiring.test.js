/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importTabsModule, DEFAULT_TABS_DOM } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (...segments) => readFileSync(path.join(repoRoot, ...segments), 'utf8');
const tabsCss = readRepoFile('public', 'css', 'sillybunny-tabs.css');
const mobileShellCss = readRepoFile('public', 'css', 'sillybunny-mobile-shell.css');
const paperThemeCss = readRepoFile('public', 'css', 'sillybunny-paper-theme.css');

let loaded = null;

afterEach(() => {
    loaded?.cleanup();
    loaded = null;
    jest.restoreAllMocks();
});

describe('top-bar extension slot wiring', () => {
    test('declares the slot sizing, panel anchoring, and mobile composer CSS contracts', () => {
        expect(tabsCss).toContain('#sb-topbar-extension-slot[data-sb-topbar-slot-empty=\'true\']');
        expect(tabsCss).toContain('#sb-topbar-extension-slot .menu_button,');
        expect(tabsCss).toContain('max-inline-size: min(12rem, 45vw);');
        expect(tabsCss).toContain('--topBarBlockSize: max(var(--sb-host-topbar-block-size), var(--sb-topbar-layout-offset));');
        expect(mobileShellCss).toContain('#sb-topbar-extension-slot .menu_button,');
        expect(paperThemeCss).toContain('#top-bar .menu_button:not(#sb-topbar-extension-slot .menu_button),');
        expect(mobileShellCss).not.toContain('#rightSendForm > div:not(#send_but)');
        expect(mobileShellCss).toContain('#rightSendForm > #mes_impersonate,');
    });

    test('adopts pre-existing and dynamically inserted top-bar extension controls into the slot and mirrors character badges', async () => {
        const domWithExtension = DEFAULT_TABS_DOM.replace(
            '<div id="top-bar"></div>',
            '<div id="top-bar"><button id="ext-preexisting-btn" class="menu_button">Ext</button></div>',
        );
        loaded = await importTabsModule({ dom: domWithExtension });

        const slot = document.getElementById('sb-topbar-extension-slot');
        expect(slot).not.toBeNull();
        expect(slot.dataset.sbTopbarSlotEmpty).toBe('false');
        expect(slot.querySelector('#ext-preexisting-btn')).not.toBeNull();

        // A third-party control appended later directly to #top-bar is adopted by the live MutationObserver.
        const lateBtn = document.createElement('button');
        lateBtn.id = 'ext-late-btn';
        lateBtn.className = 'menu_button';
        document.getElementById('top-bar').append(lateBtn);
        await loaded.flush();

        expect(slot.querySelector('#ext-late-btn')).toBe(lateBtn);
        expect(slot.dataset.sbTopbarSlotEmpty).toBe('false');

        // Badges added to the host character icon are mirrored onto the top-bar character button.
        const hostIcon = document.getElementById('rightNavDrawerIcon');
        const badge = document.createElement('span');
        badge.className = 'ext-badge';
        badge.textContent = '3';
        hostIcon.append(badge);
        await loaded.flush();

        const charToggle = document.getElementById('sb-character-toggle');
        expect(charToggle.textContent).toContain('3');
        expect(charToggle.querySelector('[data-sb-topbar-adopted="true"]')).not.toBeNull();
    });

    test('marks the extension slot empty when no extension controls exist in #top-bar', async () => {
        loaded = await importTabsModule();
        const slot = document.getElementById('sb-topbar-extension-slot');
        expect(slot).not.toBeNull();
        expect(slot.dataset.sbTopbarSlotEmpty).toBe('true');
    });

    test('places third-party composer buttons in #leftSendForm on mobile and retains #user-settings-block-content as legacy remainder', async () => {
        const domWithStray = DEFAULT_TABS_DOM
            .replace(
                '<div id="rightSendForm">',
                '<div id="rightSendForm"><div id="third-party-composer-btn" class="menu_button">TP</div>',
            )
            .replace(
                '<div id="UI-Customization-Block">',
                '<div id="UI-Customization-Block"><div id="stray-third-party-drawer" class="inline-drawer"><b>Stray</b></div>',
            );
        loaded = await importTabsModule({ dom: domWithStray, mobile: true });

        // Third-party button from #rightSendForm stays accessible in #leftSendForm on mobile,
        // and returns to #rightSendForm when resized back to desktop.
        const tpBtn = document.getElementById('third-party-composer-btn');
        expect(tpBtn).not.toBeNull();
        expect(document.getElementById('leftSendForm').contains(tpBtn)).toBe(true);

        loaded.setViewport({ width: 1440, height: 900 });
        expect(document.getElementById('rightSendForm').contains(tpBtn)).toBe(true);

        // The legacy settings remainder stays attached in the document holding #user-settings-block-content,
        // and any stray third-party drawer stays connected in the settings/extensions tree.
        const remainder = document.querySelector('.sb-legacy-settings-remainder');
        expect(remainder).not.toBeNull();
        expect(remainder.contains(document.getElementById('user-settings-block-content'))).toBe(true);
        expect(document.getElementById('stray-third-party-drawer')).not.toBeNull();
    });
});
