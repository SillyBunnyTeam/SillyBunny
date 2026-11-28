/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pub = rel => fileURLToPath(new URL(`../../public/${rel}`, import.meta.url));
const read = rel => readFileSync(pub(rel), 'utf8');

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('responses of SillyBunny-authored dialogs', () => {
    test('destructive confirm CSS uses solid danger fill rather than an 18% tint', () => {
        const css = read('css/sillybunny-message-actions.css');
        const rule = css.slice(css.indexOf('.sb-popup-destructive-confirm .menu_button.sb-popup-destructive'));
        expect(rule).toContain('background: var(--sb-color-danger);');
        expect(css).not.toMatch(/--sb-color-danger\) 18%/);
    });

    test('sillybunny-delete-confirm names responses with verbs, focuses Cancel on destructive confirms, and applies solid danger classes', async () => {
        jest.resetModules();
        const showCalls = [];
        const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
        const POPUP_TYPE = { CONFIRM: 2 };

        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            t: (s, ...v) => s.reduce((out, p, i) => out + p + (v[i] ?? ''), ''),
        }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
            POPUP_RESULT,
            POPUP_TYPE,
            Popup: class MockPopup {
                constructor(content, type, inputValue, options) {
                    this.content = content;
                    this.type = type;
                    this.options = options;
                    this.dlg = document.createElement('dialog');
                    this.okButton = document.createElement('button');
                    this.dlg.append(this.okButton);
                    showCalls.push(this);
                }
                async show() {
                    this.options?.onOpening?.(this);
                    this.options?.onOpen?.(this);
                    return POPUP_RESULT.NEGATIVE;
                }
            },
        }));

        const { confirmVerb, confirmDestructiveAction, confirmMessageDeletion } = await import('../../public/scripts/sillybunny-delete-confirm.js');

        const verbOpts = confirmVerb('Delete', { destructive: true });
        expect(verbOpts.okButton).toBe('Delete');
        expect(verbOpts.okButton).not.toBe('Yes');
        expect(verbOpts.defaultResult).toBe(POPUP_RESULT.NEGATIVE);

        await confirmDestructiveAction({ text: 'Remove item', confirmLabel: 'Delete Item', heading: 'Delete Item' });
        expect(showCalls[0].options.okButton).toBe('Delete Item');
        expect(showCalls[0].options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
        expect(showCalls[0].okButton.classList.contains('sb-popup-destructive')).toBe(true);
        expect(showCalls[0].okButton.classList.contains('is-destructive')).toBe(true);

        await confirmMessageDeletion({ confirmLabel: 'Delete Message' });
        expect(showCalls[1].options.okButton).toBe('Delete Message');
        expect(showCalls[1].options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
        expect(showCalls[1].okButton.classList.contains('sb-popup-destructive')).toBe(true);
        expect(showCalls[1].okButton.classList.contains('is-destructive')).toBe(true);
    });

    test('Conversation Mode destructive confirm applies solid danger classes and focuses Cancel', async () => {
        jest.resetModules();
        const showCalls = [];
        const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
        const POPUP_TYPE = { CONFIRM: 2 };

        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            t: (s, ...v) => s.reduce((out, p, i) => out + p + (v[i] ?? ''), ''),
        }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
            POPUP_RESULT,
            POPUP_TYPE,
            Popup: class MockPopup {
                constructor(content, type, inputValue, options) {
                    this.options = options;
                    this.dlg = document.createElement('dialog');
                    this.okButton = document.createElement('button');
                    this.dlg.append(this.okButton);
                    showCalls.push(this);
                }
                async show() {
                    this.options?.onOpening?.(this);
                    this.options?.onOpen?.(this);
                    return POPUP_RESULT.NEGATIVE;
                }
            },
        }));

        const { confirmConversationAction } = await import('../../public/scripts/sillybunny-conversation/dialogs.js');
        await confirmConversationAction({ title: 'Delete Thread', text: 'This removes the thread.', confirmLabel: 'Delete', destructive: true });

        expect(showCalls).toHaveLength(1);
        expect(showCalls[0].options.okButton).toBe('Delete');
        expect(showCalls[0].options.okButton).not.toBe('Yes');
        expect(showCalls[0].options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
        expect(showCalls[0].okButton.classList.contains('sb-popup-destructive')).toBe(true);
        expect(showCalls[0].okButton.classList.contains('is-destructive')).toBe(true);
    });

    test('Data Maid confirms both single and bulk delete with "Delete", keeps Cancel focused, and requires no removed header slot', async () => {
        jest.resetModules();
        const confirmCalls = [];
        const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };
        const POPUP_TYPE = { DISPLAY: 4, CONFIRM: 2 };

        await jest.unstable_mockModule(pub('script.js'), () => ({
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        }));
        await jest.unstable_mockModule(pub('scripts/constants.js'), () => ({ VIDEO_EXTENSIONS: [] }));
        await jest.unstable_mockModule(pub('scripts/i18n.js'), () => ({
            t: (s, ...v) => s.reduce((out, p, i) => out + p + (v[i] ?? ''), ''),
        }));
        await jest.unstable_mockModule(pub('scripts/popup.js'), () => ({
            POPUP_RESULT,
            POPUP_TYPE,
            callGenericPopup: jest.fn(async () => POPUP_RESULT.AFFIRMATIVE),
            Popup: {
                show: {
                    confirm: jest.fn(async (title, text, options) => {
                        const okButton = document.createElement('button');
                        options?.onOpening?.({ okButton });
                        confirmCalls.push({ title, text, options, okButton });
                        return false;
                    }),
                },
            },
        }));
        await jest.unstable_mockModule(pub('scripts/sillybunny-editor/status-page.js'), () => ({
            createSpinner: () => document.createElement('span'),
        }));
        await jest.unstable_mockModule(pub('scripts/templates.js'), () => ({
            renderTemplateAsync: jest.fn(async () => `
                <div class="dataMaidCategory">
                    <button class="dataMaidDeleteAll" type="button">Delete All</button>
                    <div class="dataMaidItem" data-hash="abc123">
                        <button class="dataMaidItemDelete" type="button">Delete</button>
                    </div>
                </div>
            `),
        }));
        await jest.unstable_mockModule(pub('scripts/utils.js'), () => ({
            humanFileSize: n => `${n} B`,
            timestampToMoment: () => ({ format: () => '2026-01-01' }),
        }));

        const { DataMaidDialog } = await import('../../public/scripts/data-maid-dialog.js');
        const dialog = new DataMaidDialog();
        const category = await dialog.renderCategory('images', 'Images', 'Unused images', [
            { hash: 'abc123', name: 'unused.png', size: 512, mtime: 1000 },
        ]);

        category.querySelector('.dataMaidDeleteAll').click();
        category.querySelector('.dataMaidItemDelete').click();
        await Promise.resolve();

        expect(confirmCalls).toHaveLength(2);
        for (const call of confirmCalls) {
            expect(call.options.okButton).toBe('Delete');
            expect(call.options.okButton).not.toBe('Yes');
            expect(call.options.defaultResult).toBe(POPUP_RESULT.NEGATIVE);
            expect(call.okButton.classList.contains('is-destructive')).toBe(true);
        }
    });
});
