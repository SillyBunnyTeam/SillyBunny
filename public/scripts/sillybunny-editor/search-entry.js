/**
 * Search entry (GNOME `GtkSearchEntry`): a single-line `input[type=search]` with a leading search icon and a
 * trailing clear button that CSS shows only while the input has text. It draws the field; the input inside is bare.
 *
 * The component only adds the chrome. Revealing and filtering belong to the caller, or to `createListSearch`, which
 * takes `element` as its `field` and `input` as its `input`.
 *
 * Escape clears a non-empty input and stops there; on an empty input the key is left alone, so the host's own
 * handler (close the bar, blur, leave the page) runs on the second press. A caller whose bar already closes on
 * Escape passes `clearOnEscape: false`.
 *
 * @param {object} [options]
 * @param {HTMLInputElement|null} [options.input]  Existing input to adopt. It keeps its id, value and listeners and is
 *   moved into the entry at its current position; without one, an input is built.
 * @param {string} [options.id]                   Id for a built input.
 * @param {string} [options.label]                Accessible name; an existing name on an adopted input is kept when omitted.
 * @param {string} [options.placeholder]          Placeholder text.
 * @param {string} [options.className]            Extra classes for the entry.
 * @param {string} [options.inputClassName]       Extra classes for the input.
 * @param {'field'|'bar'} [options.variant='field']  `field` is a standalone text field; `bar` is the borderless raised field of a bar.
 * @param {string} [options.clearLabel]           Name and tooltip of the clear button, already translated (the module takes no i18n
 *   import so that it loads in the foundation fixture); the default is the copy placeholder.
 * @param {boolean} [options.clearOnEscape=true]
 * @param {number} [options.debounce=0]           Milliseconds before `onInput` runs for a non-empty value. An empty value runs it at once.
 * @param {(value: string) => void} [options.onInput]
 * @returns {{ element: HTMLDivElement, input: HTMLInputElement, clearButton: HTMLButtonElement, focus: () => void,
 *   clear: () => void, setValue: (value: string, options?: { notify?: boolean }) => void, destroy: () => void }}
 */
export function createSearchEntry({
    input = null,
    id = '',
    label = '',
    placeholder,
    className = '',
    inputClassName = '',
    variant = 'field',
    clearLabel = '',
    clearOnEscape = true,
    debounce = 0,
    onInput = null,
} = {}) {
    const field = input ?? document.createElement('input');
    if (!input) {
        field.type = 'search';
        if (id) field.id = id;
    }
    field.classList.add('sb-search-entry__input', ...inputClassName.split(/\s+/).filter(Boolean));
    if (placeholder !== undefined) field.placeholder = placeholder;
    // The clear button's visibility is `:placeholder-shown`, which needs a non-empty placeholder.
    if (!field.placeholder) field.placeholder = ' ';
    if (label) field.setAttribute('aria-label', label);
    else if (!field.hasAttribute('aria-label') && !field.hasAttribute('aria-labelledby') && !field.labels?.length && field.placeholder.trim()) {
        field.setAttribute('aria-label', field.placeholder);
    }

    const entry = document.createElement('div');
    entry.className = `sb-search-entry ${className}`.trim();
    entry.dataset.variant = variant;

    const glyph = document.createElement('i');
    glyph.className = 'fa-solid fa-magnifying-glass sb-search-entry__icon';
    glyph.setAttribute('aria-hidden', 'true');

    const text = clearLabel || 'TODO(copy)';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'sb-search-entry__clear';
    clearButton.setAttribute('aria-label', text);
    clearButton.title = text;
    if (!clearLabel) clearButton.dataset.sbCopyPlaceholder = 'true';
    const cross = document.createElement('i');
    cross.className = 'fa-solid fa-xmark';
    cross.setAttribute('aria-hidden', 'true');
    clearButton.append(cross);

    field.replaceWith?.(entry);
    entry.append(glyph, field, clearButton);

    let timer = 0;

    function emit(value) {
        clearTimeout(timer);
        onInput?.(value);
    }

    function clear() {
        if (!field.value) return;
        field.value = '';
        field.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const onFieldInput = () => {
        if (!onInput) return;
        clearTimeout(timer);
        const value = field.value;
        if (!debounce || !value) emit(value);
        else timer = setTimeout(() => emit(field.value), debounce);
    };
    const onFieldKeydown = event => {
        if (!clearOnEscape || event.key !== 'Escape' || event.isComposing || !field.value) return;
        event.preventDefault();
        event.stopPropagation();
        clear();
    };
    const onClearClick = () => {
        clear();
        field.focus({ preventScroll: true });
    };
    // A click on the icon or the padding lands in the field, as it does on a labelled input.
    const onEntryPointerDown = event => {
        if (event.target === field || clearButton.contains(/** @type {Node} */ (event.target))) return;
        event.preventDefault();
        field.focus({ preventScroll: true });
    };

    field.addEventListener('input', onFieldInput);
    field.addEventListener('keydown', onFieldKeydown);
    clearButton.addEventListener('click', onClearClick);
    entry.addEventListener('pointerdown', onEntryPointerDown);

    return {
        element: entry,
        input: field,
        clearButton,
        focus: () => field.focus({ preventScroll: true }),
        clear,
        setValue(value, { notify = true } = {}) {
            clearTimeout(timer);
            field.value = value;
            if (notify) onInput?.(value);
        },
        destroy() {
            clearTimeout(timer);
            field.removeEventListener('input', onFieldInput);
            field.removeEventListener('keydown', onFieldKeydown);
            clearButton.removeEventListener('click', onClearClick);
            entry.removeEventListener('pointerdown', onEntryPointerDown);
        },
    };
}
