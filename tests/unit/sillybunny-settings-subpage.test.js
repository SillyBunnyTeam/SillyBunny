/** @jest-environment jsdom */
import { describe, test, expect } from '@jest/globals';
import { buildExtensionsSubpage } from '../../public/scripts/sillybunny-settings-subpage-descriptors.js';
import { createSubpageStack } from '../../public/scripts/sillybunny-settings-subpage.js';

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

    test('draws each group as a list labelled by its heading, with no description on user-installed rows', () => {
        const { host, stack } = mountStack(buildExtensionsSubpage(buildPanel()).rows);

        expect(groupHeadings(host)).toEqual(['System Extensions', 'User-installed Extensions']);
        for (const group of host.querySelectorAll('.sb-subpage-group')) {
            const heading = group.querySelector('.ds-pref-group-heading');
            expect(group.querySelector(':scope > [role="list"]').getAttribute('aria-labelledby')).toBe(heading.id);
            expect(heading.dataset.i18n).toBe(heading.textContent);
        }
        expect(host.querySelector('.sb-subpage-list').hasAttribute('role')).toBe(false);

        const userGroup = host.querySelector('[data-sb-subpage-group="user"]');
        expect([...userGroup.querySelectorAll('.sb-subpage-heading-title')].map(title => title.textContent)).toEqual(['QA User Extension', 'QA Dice Slot']);
        expect(userGroup.querySelector('.sb-subpage-heading-description, [data-sb-copy-placeholder]')).toBeNull();
        expect(host.textContent).not.toContain('lorum ipsum');

        stack.open('dice_container');
        expect(stack.detailTitle.textContent).toBe('QA Dice Slot');
        expect(stack.detailDescription.hidden).toBe(true);
        stack.close({ instant: true });
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
        expect(groupHeadings(host)).toEqual(['System Extensions', 'User-installed Extensions']);
        expect(host.querySelector('[data-sb-subpage-row="dice_container"]').hidden).toBe(false);
    });
});
