import { createToggleRow } from './sillybunny-editor/toggle-row.js';
import { moveCaption } from './sillybunny-editor/rows.js';

/**
 * Writes a choice into the select with the events that a picked option fires. Handlers bound to `input` and to
 * `change` both run, and jQuery handlers receive native events.
 * @param {HTMLSelectElement} select
 * @param {string} value
 */
function writeChoice(select, value) {
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Replaces the label and select of the Markdown engine setting with one toggle row, because the setting has two
 * exclusive options. The select stays in the document, inside the row and hidden, so it keeps its identity, its
 * listeners and the stored value, and the code that reads and writes the setting needs no change. Setting the
 * value of a select fires no event, so code that sets it must also dispatch `input` for the row to follow.
 *
 * The label supplies the title and its translation key. The option labels are product names, so they come from the
 * options of the select and are not translated.
 * @param {HTMLElement} root Holds the select
 * @returns {HTMLElement|null} The new row, or null when the select is missing, already presented, or has no label
 */
export function presentMarkdownEngineRow(root) {
    const select = root.querySelector('#markdown_engine');
    if (!(select instanceof HTMLSelectElement) || select.closest('.ds-toggle-row')) return null;

    const source = select.parentElement;
    const title = source?.querySelector(':scope > label > small:not(.ds-row-subtitle)');
    if (!(source instanceof HTMLElement) || !(title instanceof HTMLElement)) return null;
    const note = source.querySelector(':scope > label > .ds-row-subtitle');

    const toggle = createToggleRow({
        label: title.textContent.trim(),
        subtitle: note?.textContent.trim() || undefined,
        field: 'markdown-engine',
        id: 'sb-markdown-engine',
        choices: [...select.options].map(option => [option.value, option.textContent.trim()]),
        value: select.value,
        onChange: engine => writeChoice(select, engine),
    });

    const caption = toggle.row.querySelector('.ds-row-label');
    if (title.dataset.i18n) caption.dataset.i18n = title.dataset.i18n;
    const subtitle = toggle.row.querySelector('.ds-row-subtitle');
    if (subtitle instanceof HTMLElement && note instanceof HTMLElement) {
        moveCaption(subtitle, note);
        if (note.dataset.sbCopyPlaceholder) subtitle.dataset.sbCopyPlaceholder = note.dataset.sbCopyPlaceholder;
    }

    const follow = () => toggle.setValue(select.value);
    select.addEventListener('input', follow);
    select.addEventListener('change', follow);

    source.replaceWith(toggle.row);
    select.hidden = true;
    toggle.row.append(select);
    return toggle.row;
}
