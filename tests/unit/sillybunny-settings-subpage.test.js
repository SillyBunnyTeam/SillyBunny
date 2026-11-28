/** @jest-environment jsdom */
import { afterEach, describe, test, expect, jest } from '@jest/globals';
import { buildExtensionsLead, buildExtensionsSubpage } from '../../public/scripts/sillybunny-settings-subpage-descriptors.js';
import { createSubpageStack } from '../../public/scripts/sillybunny-settings-subpage.js';
import { importTabsModule, DEFAULT_TABS_DOM } from '../util/tabs-harness.js';

/** A settings drawer titled the way extensions title their own. */
function drawer(title) {
    return `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>${title}</b></div><div class="inline-drawer-content"><input type="checkbox"></div></div>`;
}

/**
 * The Extensions panel with two extensions SillyBunny ships and two the user installed: one
 * appended to a settings column and one in a container slot that the page authors.
 */
function buildPanel() {
    document.body.innerHTML = `
        <div id="panel">
            <div id="rm_extensions_block">
                <div class="extensions_block">
                    <div id="extensions_settings">
                        <div id="assets_container" class="extension_container">${drawer('Download Extensions & Assets')}</div>
                        <div id="sd_container" class="extension_container">${drawer('Image Generation')}</div>
                        <div id="rvc_container" class="extension_container"></div>
                        <div class="qa-user-extension">${drawer('QA User Extension')}</div>
                    </div>
                    <div id="extensions_settings2">
                        <div id="dice_container" class="extension_container">${drawer('QA Dice Slot')}</div>
                        <div id="regex_container" class="extension_container">${drawer('Regex')}</div>
                    </div>
                </div>
            </div>
        </div>`;
    return document.getElementById('panel');
}

function mountStack(rows) {
    const host = document.createElement('div');
    document.body.append(host);
    const stack = createSubpageStack(host, { name: 'extensions' });
    stack.setRows(rows);
    return { host, stack };
}

const groupHeadings = host => [...host.querySelectorAll('.sb-subpage-group:not([hidden]) .ds-pref-group-heading')].map(heading => heading.textContent);

describe('Extensions list groups', () => {
    test('lists the extensions SillyBunny ships first, with descriptions, and user-installed ones after, without', () => {
        const { rows } = buildExtensionsSubpage(buildPanel());

        expect(rows.map(row => [row.label, row.group.id])).toEqual([
            ['Image Generation', 'system'],
            ['Regex', 'system'],
            ['QA User Extension', 'user'],
            ['QA Dice Slot', 'user'],
        ]);
        expect(rows.slice(0, 2).every(row => row.description && row.descriptionKey === row.description)).toBe(true);
        expect(rows.slice(2).map(row => row.description)).toEqual([undefined, undefined]);
    });

    test('draws each group as a preference group labelled by its heading, with no description on user-installed rows', () => {
        const { host, stack } = mountStack(buildExtensionsSubpage(buildPanel()).rows);

        expect(groupHeadings(host)).toEqual(['System Extensions', 'User-Installed Extensions']);
        for (const group of host.querySelectorAll('.sb-subpage-group')) {
            const heading = group.querySelector('.ds-pref-group-heading');
            const box = group.querySelector(':scope > .ds-pref-group');
            expect(box.getAttribute('role')).toBe('group');
            expect(box.getAttribute('aria-labelledby')).toBe(heading.id);
            expect(heading.dataset.i18n).toBe(heading.textContent);
        }
        expect(host.querySelector('.sb-subpage-list').hasAttribute('role')).toBe(false);
        expect(host.querySelector('[role="list"]')).toBeNull();

        const userGroup = host.querySelector('[data-sb-subpage-group="user"]');
        expect([...userGroup.querySelectorAll('.ds-row-label')].map(title => title.textContent)).toEqual(['QA User Extension', 'QA Dice Slot']);
        expect(userGroup.querySelector('.ds-row-subtitle, [data-sb-copy-placeholder]')).toBeNull();
        expect(host.textContent).not.toContain('lorum ipsum');

        stack.open('dice_container');
        expect(stack.detailTitle.textContent).toBe('QA Dice Slot');
        expect(stack.detailDescription.hidden).toBe(true);
        stack.close({ instant: true });
    });

    test('draws each extension as an activatable row that keeps its container id', () => {
        const { host } = mountStack(buildExtensionsSubpage(buildPanel()).rows);
        const rows = [...host.querySelectorAll('.sb-subpage-row')];

        expect(rows.map(row => row.dataset.sbSubpageRow)).toEqual(['sd_container', 'regex_container', 'extension-1', 'dice_container']);
        expect(rows.every(row => row.matches('button.ds-row.ds-row--activatable'))).toBe(true);
    });

    test('puts a decorative Font Awesome icon on System Extensions rows and none on user-installed ones', () => {
        const { host } = mountStack(buildExtensionsSubpage(buildPanel()).rows);
        const icons = id => [...host.querySelectorAll(`[data-sb-subpage-row="${id}"] > i.sb-subpage-row-icon`)];

        expect(icons('sd_container').map(icon => icon.className)).toEqual(['fa-solid fa-image sb-subpage-row-icon']);
        expect(icons('regex_container').map(icon => icon.className)).toEqual(['fa-solid fa-asterisk sb-subpage-row-icon']);
        const [image] = icons('sd_container');
        expect(image.getAttribute('aria-hidden')).toBe('true');
        expect(image.nextElementSibling.matches('.ds-row-text')).toBe(true);
        expect(host.querySelector('[data-sb-subpage-row="sd_container"] .ds-row-label').textContent).toBe('Image Generation');
        expect(icons('extension-1')).toHaveLength(0);
        expect(icons('dice_container')).toHaveLength(0);
        expect(host.querySelector('[data-sb-subpage-group="user"] .sb-subpage-row-icon')).toBeNull();
    });

    test('reads each icon from the description of the built-in extension, and gives user-installed rows none to read', () => {
        const panel = buildPanel();
        panel.querySelector('#extensions_settings').insertAdjacentHTML('beforeend', `<div id="sbdbg-settings" class="extension_container">${drawer('Debugger')}</div>`);
        const rows = buildExtensionsSubpage(panel).rows;

        expect(rows.find(row => row.id === 'sbdbg-settings').icon).toBe('fa-bug');
        expect(rows.filter(row => row.group.id === 'user').map(row => row.icon)).toEqual([undefined, undefined]);
        expect(rows.filter(row => row.group.id === 'system').every(row => /^fa-[a-z-]+$/.test(row.icon))).toBe(true);
    });

    test('puts page-level groups in the lead above the list, and labels Back with the text it is given', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const stack = createSubpageStack(host, { name: 'extensions', backLabel: 'Zurück' });
        const lead = document.createElement('section');
        stack.listLead.append(lead);

        expect(stack.list.firstElementChild).toBe(stack.listLead);
        expect(stack.listLead.nextElementSibling).toBe(stack.listBody);
        expect(stack.backButton.getAttribute('aria-label')).toBe('Zurück');
        expect(stack.backButton.title).toBe('Zurück');
    });

    test('shows no User-installed heading when the user has installed nothing', () => {
        const panel = buildPanel();
        panel.querySelector('.qa-user-extension').remove();
        panel.querySelector('#dice_container').replaceChildren();
        const { host } = mountStack(buildExtensionsSubpage(panel).rows);

        expect(groupHeadings(host)).toEqual(['System Extensions']);
        expect(host.querySelector('[data-sb-subpage-group="user"]')).toBeNull();
    });

    test('hides a group while none of its rows has a section to show', () => {
        const panel = buildPanel();
        const { host, stack } = mountStack(buildExtensionsSubpage(panel).rows);
        const diceSlot = panel.querySelector('#dice_container');
        const diceContent = [...diceSlot.childNodes];

        panel.querySelector('.qa-user-extension').replaceChildren();
        diceSlot.replaceChildren();
        stack.sync();
        expect(groupHeadings(host)).toEqual(['System Extensions']);

        diceSlot.append(...diceContent);
        stack.sync();
        expect(groupHeadings(host)).toEqual(['System Extensions', 'User-Installed Extensions']);
        expect(host.querySelector('[data-sb-subpage-row="dice_container"]').hidden).toBe(false);
    });
});

const ASSETS_UI = `
    <div id="assets_ui">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b data-i18n="Download Extensions & Assets">Download Extensions & Assets</b></div>
            <div class="inline-drawer-content">
                <small><span>Load a custom asset list or select</span> <a class="assets-install-hint-link">Install&nbsp;Extension</a></small>
                <div class="assets-url-block">
                    <label for="assets-json-url-field">Assets URL</label>
                    <small title="Load a list"><span>Load an asset list</span></small>
                    <div class="assets-connect-div">
                        <input id="assets-json-url-field" class="text_pole">
                        <i id="assets-connect-button" class="menu_button fa-solid fa-plug-circle-exclamation"></i>
                    </div>
                </div>
                <div id="assets_filters"><select id="assets_type_select"></select></div>
                <div id="assets_menu"></div>
            </div>
        </div>
    </div>`;

/** The block of page actions as `index.html` writes it, and the container the assets extension mounts into. */
function buildLeadPanel() {
    document.body.innerHTML = `
        <div id="panel">
            <div class="extensions_block">
                <div class="alignitemscenter">
                    <h3 data-i18n="Extensions">Extensions</h3>
                    <label for="extensions_notify_updates" class="checkbox_label">
                        <input id="extensions_notify_updates" type="checkbox">
                        <span data-i18n="Notify on extension updates">Notify on extension updates</span>
                        <small data-i18n="Show a notice">Show a notice</small>
                    </label>
                    <div id="extensions_details" class="menu_button"><i class="fa-solid fa-cubes"></i><span data-i18n="Manage extensions">Manage extensions</span></div>
                    <div id="third_party_extension_button" class="menu_button" title="Import" data-i18n="[title]Import"><i class="fa-solid fa-cloud-arrow-down"></i><span data-i18n="Install extension">Install extension</span></div>
                </div>
                <div id="extensions_settings"><div id="assets_container" class="extension_container"></div></div>
            </div>
        </div>`;
    return document.getElementById('panel');
}

describe('Extensions page lead groups', () => {
    test('presents the page actions as one group and keeps the upstream controls', () => {
        const panel = buildLeadPanel();
        const manage = panel.querySelector('#extensions_details');
        const install = panel.querySelector('#third_party_extension_button');
        const notify = panel.querySelector('#extensions_notify_updates');
        let opened = 0;
        manage.addEventListener('click', () => { opened++; });

        const { sections } = buildExtensionsLead(panel, panel.querySelector('#assets_container'));
        const group = sections[0];

        // The group has no title: no heading and no empty header block. Its name is the upstream heading, as an aria-label.
        expect(group.querySelector('.ds-pref-group-heading, .ds-pref-group-header, h1, h2, h3, h4, h5, h6')).toBeNull();
        const box = group.querySelector('[role="group"]');
        expect(box.getAttribute('aria-label')).toBe('Extensions');
        expect(box.dataset.i18n).toBe('[aria-label]Extensions');
        expect(box.hasAttribute('aria-labelledby')).toBe(false);
        expect(group.querySelector('#extensions_details')).toBe(manage);
        expect(group.querySelector('#third_party_extension_button')).toBe(install);
        expect(manage.matches('.ds-row.ds-button-row--arrow')).toBe(true);
        expect(manage.querySelector('.ds-row-label').textContent).toBe('Manage extensions');
        expect(install.querySelector('.ds-row-label').dataset.i18n).toBe('Install extension');
        expect(install.dataset.i18n).toBe('[title]Import');
        expect(group.contains(notify)).toBe(true);
        expect(notify.closest('.ds-row').querySelector('.ds-row-subtitle').textContent).toBe('Show a notice');
        expect(panel.querySelector('label[for="extensions_notify_updates"]')).toBeNull();

        manage.click();
        expect(opened).toBe(1);
    });

    test('presents the assets section when the extension mounts it after the page is built', async () => {
        const panel = buildLeadPanel();
        const pinned = panel.querySelector('#assets_container');
        let presented = 0;
        const lead = buildExtensionsLead(panel, pinned, { onPresented: () => { presented++; } });
        expect(presented).toBe(0);

        pinned.insertAdjacentHTML('beforeend', ASSETS_UI);
        await new Promise(resolve => setTimeout(resolve));

        expect(presented).toBe(1);
        const ui = pinned.querySelector('#assets_ui');
        const input = ui.querySelector('#assets-json-url-field');
        const connect = ui.querySelector('#assets-connect-button');
        expect(ui.querySelector('.ds-pref-group-heading').textContent).toBe('Download Extensions & Assets');
        expect(ui.querySelector('.ds-pref-group-subtitle a.assets-install-hint-link')).not.toBeNull();
        expect(ui.querySelector('.ds-row-entry--floating').contains(input)).toBe(true);
        expect(ui.querySelector('.ds-row-entry__title').textContent).toBe('Assets URL');
        expect(ui.querySelector('.inline-drawer')).toBeNull();
        // What the extension shows once a list is loaded stays as it was, after the group.
        expect([...ui.children].slice(-2).map(node => node.id)).toEqual(['assets_filters', 'assets_menu']);

        let clicked = 0;
        connect.addEventListener('click', () => { clicked++; });
        expect(connect.getAttribute('role')).toBe('button');
        expect(connect.tabIndex).toBe(0);
        connect.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(clicked).toBe(1);
        lead.disconnect();
    });
});

let loadedShell = null;

afterEach(() => {
    jest.useRealTimers();
    loadedShell?.cleanup();
    loadedShell = null;
    jest.restoreAllMocks();
});

/**
 * Boots the real `sillybunny-tabs.js` module with an Extensions panel containing two built-in
 * extensions (`sd_container`, `regex_container`) so `revealSetting()` exercises the real
 * `revealSearchMatch` timer ladder against the live subpage stack.
 */
async function loadSearchJump() {
    jest.useFakeTimers();
    const extDom = DEFAULT_TABS_DOM
        .replace(
            '<div id="extensions_settings"></div>',
            `<div id="extensions_settings">
                <div id="assets_container" class="extension_container">${drawer('Download Extensions & Assets')}</div>
                <div id="sd_container" class="extension_container">${drawer('Image Generation')}</div>
                <div id="rvc_container" class="extension_container"></div>
                <div class="qa-user-extension">${drawer('QA User Extension')}</div>
            </div>`,
        )
        .replace(
            '<div id="extensions_settings2"></div>',
            `<div id="extensions_settings2">
                <div id="dice_container" class="extension_container">${drawer('QA Dice Slot')}</div>
                <div id="regex_container" class="extension_container">${drawer('Regex')}</div>
            </div>`,
        );

    loadedShell = await importTabsModule({ dom: extDom });
    const origMatchMedia = window.matchMedia;
    window.matchMedia = query => (
        /prefers-reduced-motion:\s*reduce/i.test(String(query))
            ? { matches: false, media: String(query), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
            : origMatchMedia(query)
    );
    const scrolled = [];
    const origScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function recordScroll() {
        scrolled.push(this);
    };
    const origCleanup = loadedShell.cleanup;
    loadedShell.cleanup = () => {
        HTMLElement.prototype.scrollIntoView = origScrollIntoView;
        origCleanup();
    };

    // Open Extensions once so the subpage stack is built, then close back to list state.
    loadedShell.shell.openTab('right', 'extensions');

    const inputOf = containerId => document.querySelector(`#${containerId} input`);
    const openRowId = () => {
        const detail = document.querySelector('.sb-subpage-detail:not([hidden])');
        if (!detail) return null;
        return detail.querySelector('.extension_container')?.id ?? null;
    };
    const backButton = () => document.querySelector('.sb-subpage-back');
    const jumpTo = containerId => loadedShell.shell.revealSetting('right', 'extensions', `#${containerId} input`);

    return {
        scrolled,
        inputOf,
        openRowId,
        backButton,
        jumpTo,
        advance: ms => jest.advanceTimersByTime(ms),
    };
}

describe('Search jumps into the Extensions list', () => {
    test('a jump opens the page that holds the match, then scrolls to it', async () => {
        const { scrolled, inputOf, openRowId, jumpTo, advance } = await loadSearchJump();

        jumpTo('regex_container');
        advance(500);

        expect(openRowId()).toBe('regex_container');
        expect(scrolled).toContain(inputOf('regex_container'));
    });

    test('Back before the jump finishes keeps the page closed', async () => {
        const { scrolled, openRowId, backButton, jumpTo, advance } = await loadSearchJump();
        document.querySelector('[data-sb-subpage-row="regex_container"]').click();

        jumpTo('regex_container');
        backButton().click();
        advance(500);

        expect(openRowId()).toBeNull();
        expect(scrolled).toEqual([]);
    });

    test('Back while the page slides in stops the jump before it scrolls', async () => {
        const { scrolled, openRowId, backButton, jumpTo, advance } = await loadSearchJump();

        jumpTo('regex_container');
        advance(100);
        expect(openRowId()).toBe('regex_container');
        backButton().click();
        advance(500);

        expect(openRowId()).toBeNull();
        expect(scrolled).toEqual([]);
    });

    test('a page the user opens before the jump finishes stays open', async () => {
        const { scrolled, openRowId, jumpTo, advance } = await loadSearchJump();

        jumpTo('regex_container');
        document.querySelector('[data-sb-subpage-row="sd_container"]').click();
        advance(500);

        expect(openRowId()).toBe('sd_container');
        expect(scrolled).toEqual([]);
    });

    test('a newer jump replaces an older one whose timers have not run', async () => {
        const { scrolled, inputOf, openRowId, jumpTo, advance } = await loadSearchJump();

        jumpTo('regex_container');
        jumpTo('sd_container');
        advance(500);

        expect(openRowId()).toBe('sd_container');
        expect(scrolled).toContain(inputOf('sd_container'));
        expect(scrolled).not.toContain(inputOf('regex_container'));
    });
});
