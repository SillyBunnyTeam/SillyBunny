/**
 * The two small surfaces that every folder list shares: the popover that asks for a folder's name (to make a folder and
 * to rename one) and the colour picker of a folder. The Folder Manager and the conversation list both use them, so a
 * folder's name is asked and checked in one way wherever it is made.
 */

import { t } from '../i18n.js';
import { openPopover } from '../sillybunny-action-menu.js';
import { openAlert } from './dialog.js';

export const DEFAULT_FOLDER_COLOR = 'rgba(128, 128, 128, 1)';
export const PLACEHOLDER_COPY = 'TODO(copy)';

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
}

/** @returns {{ ok: true, name: string } | { ok: false, error: string }} */
export function parseFolderName(value) {
    const name = String(value ?? '').trim();
    return name ? { ok: true, name } : { ok: false, error: t`Enter a folder name.` };
}

/**
 * Opens a popover with one name field and a button, on `trigger`. Enter in the field presses the button; the button is
 * off while the name is not valid; a name that the page refuses (the store throws, or the promise rejects) shows under
 * the field and the popover stays open.
 * @param {object} options
 * @param {HTMLElement} options.trigger
 * @param {HTMLElement|null} [options.bounds]
 * @param {string} options.title The label of the field, which is also the popover's name.
 * @param {string} options.submitLabel
 * @param {string} [options.value] What the field holds when it opens.
 * @param {number} [options.maxLength] The most characters that the field takes.
 * @param {boolean} [options.trackTrigger] False when the trigger's `aria-expanded` is its own, as a section heading's is.
 * @param {(value: string) => { ok: true, name: string } | { ok: false, error: string }} [options.parse]
 * @param {(name: string) => void | false | { focus?: () => void } | Promise<void | false | { focus?: () => void }>} options.onSubmit
 * Runs with the parsed name. `false` keeps the popover open; an object with `focus` is called after the popover closed.
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openFolderNamePopover({ trigger, bounds = null, title, submitLabel, value = '', maxLength = 0, trackTrigger = true, parse = parseFolderName, onSubmit }) {
    const content = element('div', 'sb-manager-name-popover');
    const label = element('strong', 'sb-manager-name-popover__label', title);
    const input = element('input', 'text_pole sb-dialog__entry sb-manager-name-popover__input');
    input.type = 'text';
    input.value = value;
    if (maxLength > 0) input.maxLength = maxLength;
    label.id = 'sb-folder-manager-new-label';
    const error = element('small', 'sb-folder-manager__error sb-manager-name-popover__error');
    error.hidden = true;
    input.setAttribute('aria-describedby', error.id = 'sb-folder-manager-new-error');
    const submit = element('button', 'menu_button sb-dialog__response is-suggested menu_button_primary sb-manager-name-popover__create', submitLabel);
    submit.type = 'button';
    submit.disabled = !parse(value).ok;

    const updateValidity = () => {
        const parsed = parse(input.value);
        submit.disabled = !parsed.ok;
        error.textContent = parsed.ok ? '' : parsed.error;
        error.hidden = parsed.ok || !input.value;
        input.setAttribute('aria-invalid', String(!parsed.ok && Boolean(input.value)));
    };
    const showError = (message) => {
        error.textContent = message;
        error.hidden = false;
        // A message that is not written yet says so in markup, as the other placeholders do.
        if (message === PLACEHOLDER_COPY) error.setAttribute('data-sb-copy-placeholder', 'true');
        else error.removeAttribute('data-sb-copy-placeholder');
    };
    const finish = (result) => {
        if (result === false) return;
        popup.close();
        result?.focus?.();
    };
    const press = () => {
        const parsed = parse(input.value);
        if (!parsed.ok) {
            showError(parsed.error);
            input.setAttribute('aria-invalid', 'true');
            input.focus({ preventScroll: true });
            return undefined;
        }
        let result;
        try {
            result = onSubmit(parsed.name);
        } catch (failure) {
            showError(String(failure?.message ?? failure));
            return undefined;
        }
        if (typeof result?.then !== 'function') return finish(result);
        input.disabled = true;
        return result.then(finish, failure => showError(String(failure?.message ?? failure))).finally(() => {
            input.disabled = false;
        });
    };

    submit.addEventListener('click', press);
    input.addEventListener('input', updateValidity);
    input.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key !== 'Enter') return;
        updateValidity();
        if (!submit.disabled) { event.preventDefault(); submit.click(); }
    });
    content.append(label, input, error, submit);
    const popup = openPopover({ trigger, content, title, titleLabel: label, titleInput: input, bounds, initialFocus: () => input, trackTrigger });
    return popup;
}

/**
 * The colour picker of a folder: a `toolcool-color-picker` that reports each change as a string.
 * @param {{ value?: string, onChange: (color: string) => void }} options
 * @returns {HTMLElement}
 */
export function createFolderColorPicker({ value = '', onChange }) {
    const picker = element('toolcool-color-picker');
    picker.setAttribute('aria-label', t`Folder Colour`);
    picker.setAttribute('color', value || DEFAULT_FOLDER_COLOR);
    picker.addEventListener('change', event => {
        const color = event.detail?.rgba ?? event.detail?.color ?? picker.color ?? picker.getAttribute('color') ?? '';
        onChange(String(color));
    });
    return picker;
}

/**
 * Opens a popover on `trigger` that holds the colour picker of a folder, open at once.
 * @param {{ trigger: HTMLElement, bounds?: HTMLElement|null, value?: string, trackTrigger?: boolean, onChange: (color: string) => void }} options
 * @returns {{ close: () => void, readonly isOpen: boolean }}
 */
export function openFolderColorPopover({ trigger, bounds = null, value = '', trackTrigger = true, onChange }) {
    const content = element('div', 'sb-manager-name-popover sb-folder-color-popover');
    const picker = createFolderColorPicker({ value, onChange });
    content.append(picker);
    const popup = openPopover({ trigger, content, title: t`Folder Colour`, bounds, initialFocus: () => picker, trackTrigger });
    requestAnimationFrame(() => picker.shadowRoot?.querySelector('.button')?.click());
    return popup;
}

/**
 * Asks whether to delete a folder, with Cancel focused. The body is the placeholder until it is written, and says so in markup.
 * @param {string} body
 * @returns {Promise<boolean>} True when the user chose Delete.
 */
export async function confirmFolderDelete(body) {
    const bodyNode = element('span', '', body);
    if (body === PLACEHOLDER_COPY) bodyNode.setAttribute('data-sb-copy-placeholder', 'true');
    const response = await openAlert({
        heading: t`Delete Folder?`,
        bodyNode,
        responses: [{ id: 'cancel', label: t`Cancel` }, { id: 'delete', label: t`Delete`, appearance: 'destructive' }],
        closeResponse: 'cancel',
    });
    return response === 'delete';
}
