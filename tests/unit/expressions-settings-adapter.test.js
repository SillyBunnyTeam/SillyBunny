/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    translate: text => text,
}));
jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    MOBILE_QUERY: '',
    getRevealScrollTop: () => 0,
    positionPopover: () => {},
    openActionMenu: () => {},
    openPopover: () => {},
    closeActionMenu: () => {},
    isActionMenuOpen: () => false,
    getActionMenuTrigger: () => null,
}));

const { adoptExpressionsSettings } = await import('../../public/scripts/sillybunny-editor/adapters/utility-dialogs.js');

const publicFile = path => readFileSync(new URL(`../../public/scripts/extensions/expressions/${path}`, import.meta.url), 'utf8');

beforeAll(() => {
    new Function(readFileSync(new URL('../../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8')).call(window);
});

/** The page as the extension builds it: the real template in its container, with the saved prompt strategy set. */
function renderPage() {
    document.body.innerHTML = `<div id="expressions_container">${publicFile('settings.html')}</div>`;
    const root = document.querySelector('#expressions_container');
    root.querySelector('#expression_prompt_full').checked = true;
    return root;
}

beforeEach(() => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('the Character Expressions settings adapter', () => {
    test('shows the two prompt strategies as a toggle row over the same radios', () => {
        const root = renderPage();
        const radios = [...root.querySelectorAll('input[name="expression_prompt_type"]')];
        adoptExpressionsSettings(root);

        const row = root.querySelector('.ds-toggle-row');
        expect(row).not.toBeNull();
        expect(row.querySelector('.ds-row-label').textContent.trim()).toBe('LLM Prompt Strategy');
        expect(row.querySelector('.ds-row-label').dataset.i18n).toBe('LLM Prompt Strategy');
        expect(row.querySelector('[role="radiogroup"]')).not.toBeNull();
        expect([...row.querySelectorAll('input[type="radio"]')]).toEqual(radios);
        expect(radios.map(radio => radio.id)).toEqual(['expression_prompt_raw', 'expression_prompt_full']);
        expect(radios.map(radio => radio.checked)).toEqual([false, true]);
        expect(root.querySelector('.expression_prompt_type_block > label')).toBeNull();
    });

    test('keeps the extension\'s own handler on a radio that moved into the row', () => {
        const root = renderPage();
        const seen = [];
        window.$('#expression_prompt_raw').on('input', () => seen.push('raw'));
        adoptExpressionsSettings(root);
        const raw = root.querySelector('#expression_prompt_raw');
        raw.checked = true;
        raw.dispatchEvent(new Event('input', { bubbles: true }));
        expect(seen).toEqual(['raw']);
    });

    test('makes the sprite folder override an entry row with its help below and Submit at its end', () => {
        const root = renderPage();
        const input = root.querySelector('#expression_override');
        const submit = root.querySelector('#expression_override_button');
        adoptExpressionsSettings(root);

        const row = input.closest('.ds-row-entry--floating');
        expect(row).not.toBeNull();
        expect(row.querySelector('.ds-row-label').textContent).toBe('Sprite Folder Override');
        expect(row.querySelector('.ds-row-entry__caption').textContent).toContain('Use a forward slash to specify a subfolder');
        expect(input.getAttribute('aria-describedby')).toBe(row.querySelector('.ds-row-entry__caption').id);
        expect(submit.closest('.ds-row-suffix')).not.toBeNull();
        expect(submit.localName).toBe('button');
        expect(submit.textContent.trim()).toBe('');
        expect(submit.getAttribute('aria-label')).toBe(submit.getAttribute('title'));
        expect(root.querySelectorAll('label[for="expression_override"]')).toHaveLength(1);
        expect(root.querySelector('label[for="expression_override"]')).toBe(row.querySelector('.ds-row-label'));
    });

    test('shows every sprite action as a label-only button row in one group, with ids and handlers unchanged', () => {
        const root = renderPage();
        const ids = ['expressions_generate_missing_sprites', 'expressions_upload_sprite_sheet', 'expressions_redo_sprite_cleanup', 'expressions_stop_sprite_generation', 'expression_upload_pack_button', 'expressions_remove_all_sprites', 'expression_override_cleanup_button'];
        const clicks = [];
        for (const id of ids) window.$(`#${id}`).on('click', () => clicks.push(id));
        adoptExpressionsSettings(root);

        const group = root.querySelector('.ds-pref-group');
        expect(group).not.toBeNull();
        expect(group.getAttribute('aria-labelledby')).toBe('image_list_header');
        expect(root.querySelector('.expression_buttons')).toBeNull();
        for (const id of ids) {
            const button = root.querySelector(`#${id}`);
            expect(button.closest('.ds-pref-group')).toBe(group);
            expect(button.classList.contains('ds-button-row')).toBe(true);
            expect(button.querySelector('i')).toBeNull();
            expect(button.textContent.trim()).not.toBe('');
            button.click();
        }
        expect(clicks).toEqual(ids);
        expect(['expressions_remove_all_sprites', 'expression_override_cleanup_button'].map(id => root.querySelector(`#${id}`).classList.contains('is-destructive'))).toEqual([true, true]);
        expect(root.querySelector('#expressions_generate_missing_sprites').classList.contains('is-destructive')).toBe(false);
    });

    test('keeps the translation keys of a button row\'s caption and of its tooltip', () => {
        const root = renderPage();
        adoptExpressionsSettings(root);
        const button = root.querySelector('#expressions_generate_missing_sprites');
        expect(button.querySelector('.ds-row-label').dataset.i18n).toBe('Generate missing sprites');
        expect(button.dataset.i18n).toBe('[title]Generate all missing sprites in this set with Quick Image Gen');
        expect(button.title).toBe('Generate all missing sprites in this set with Quick Image Gen');
    });

    test('makes the agent status one row and announces the status text', () => {
        const root = renderPage();
        adoptExpressionsSettings(root);
        const status = root.querySelector('.expression_agent_status');
        expect(status.classList.contains('ds-row')).toBe(true);
        expect(status.querySelector('.ds-row-label').textContent).toBe('Agent Auto-Generation');
        expect(status.querySelector('.ds-row-label').dataset.i18n).toBe('Agent Auto-Generation');
        expect(status.querySelectorAll('.ds-row-subtitle')).toHaveLength(2);
        expect(status.querySelector('#expressions_agent_status_text').getAttribute('role')).toBe('status');
    });

    test('is safe to run twice', () => {
        const root = renderPage();
        adoptExpressionsSettings(root);
        const html = root.innerHTML;
        adoptExpressionsSettings(root);
        expect(root.innerHTML).toBe(html);
    });
});

describe('the Character Expressions markup', () => {
    const page = new DOMParser().parseFromString(`<body>${publicFile('settings.html')}</body>`, 'text/html');
    const tile = new DOMParser().parseFromString(`<body>${publicFile('list-item.html')}</body>`, 'text/html');

    test('the add and remove buttons of the custom expressions are native buttons with a name', () => {
        for (const id of ['expression_custom_add', 'expression_custom_remove']) {
            const button = page.querySelector(`#${id}`);
            expect(button.localName).toBe('button');
            expect(button.getAttribute('aria-label')).toBe(button.getAttribute('title'));
            expect(button.textContent.trim()).toBe('');
        }
    });

    test('row titles and button labels are in header capitalisation and every translation key is kept', () => {
        const text = key => page.querySelector(`[data-i18n="${key}"]`)?.textContent.trim();
        // The key is the one upstream has; only the visible English text is recased.
        expect([
            'Translate text to English before classification',
            'Allow multiple sprites per expression',
            'Re-roll if same expression is used again',
            'Auto-generate missing sprites during chat',
            'Share Quick Image Gen LLM override profile',
            'Sprite generation mode',
            'Sprite framing',
            'Remove background (white/solid-color sheets only)',
            'Filter expressions for available sprites',
            'Generate missing sprites',
            'Upload character sheet',
            'Redo crop/cleanup',
            'Stop generation',
            'Upload sprite pack (ZIP)',
            'Remove all sprites',
            'Remove all image overrides',
            'Sprite set:',
        ].map(text)).toEqual([
            'Translate Text to English Before Classification',
            'Allow Multiple Sprites per Expression',
            'Re-Roll if Same Sprite Is Used Again',
            'Auto-Generate Missing Sprites During Chat',
            'Share Quick Image Gen LLM Override Profile',
            'Sprite Generation Mode',
            'Sprite Framing',
            'Remove Background (White/Solid-Color Sheets Only)',
            'Filter Expressions for Available Sprites',
            'Generate Missing Sprites',
            'Upload Character Sheet',
            'Redo Crop/Cleanup',
            'Stop Generation',
            'Upload Sprite Pack (ZIP)',
            'Remove All Sprites',
            'Remove All Image Overrides',
            'Sprite Set:',
        ]);
    });

    test('each sprite tile has native buttons named by their tooltip, and its image is a button too', () => {
        const buttons = [...tile.querySelectorAll('.expression_list_buttons > button')];
        expect(buttons.map(button => button.className.match(/expression_list_(\w+)/)[1])).toEqual(['upload', 'regenerate', 'generate', 'delete']);
        for (const button of buttons) {
            expect(button.getAttribute('aria-label')).toBe(button.getAttribute('title'));
            expect(button.textContent.trim()).toBe('');
        }
        const image = tile.querySelector('.expression_list_image_container');
        expect(image.localName).toBe('button');
        expect(image.querySelector('img').getAttribute('alt')).toBe('{{this.title}}');
        expect(tile.querySelector('.expression_list_item').classList.contains('interactable')).toBe(false);
        expect(tile.querySelector('.expression_list_item [role="button"], .expression_list_item button button')).toBeNull();
    });
});
