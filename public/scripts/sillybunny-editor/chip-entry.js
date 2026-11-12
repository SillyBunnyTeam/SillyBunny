import { t } from '../i18n.js';

let nextDatalistId = 0;

function defaultSplit(text) {
    return text.split(',').map(value => value.trim()).filter(Boolean);
}

/**
 * Editable chips with caller-owned tokenization (including comma-bearing regex keys).
 * `split` returns tokens in order, including any unfinished final fragment. A trailing
 * comma belongs to that fragment only when the splitter leaves it in the last token.
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string} options.field
 * @param {string[]} [options.values=[]]
 * @param {string} [options.placeholder='']
 * @param {(text: string) => string[]} [options.split]
 * @param {(value: string) => string} [options.normalize]
 * @param {boolean} [options.allowDuplicates=false]
 * @param {(() => string[])|null} [options.suggestions=null]
 * @param {(value: string) => string} [options.chipLabel]
 * @param {((value: string) => string)|string|null} [options.chipClass=null]
 * @param {(values: string[]) => void} [options.onChange]
 * @param {(value: string) => string} [options.removeLabel]
 * @param {number} [options.maxChips=Infinity]
 * @returns {{ element: HTMLDivElement, input: HTMLInputElement, getValues: () => string[],
 *   setValues: (values: string[], options?: { silent?: boolean }) => void,
 *   commitPending: () => string[], getPending: () => string, focus: () => void,
 *   setDisabled: (disabled: boolean) => void, destroy: () => void }}
 */
export function createChipEntry({
    label,
    field,
    values = [],
    placeholder = '',
    split = defaultSplit,
    normalize = value => value.trim(),
    allowDuplicates = false,
    suggestions = null,
    chipLabel = value => value,
    chipClass = null,
    onChange,
    removeLabel = value => t`Remove ${value}`,
    maxChips = Infinity,
}) {
    if (maxChips !== Infinity && (!Number.isInteger(maxChips) || maxChips < 0)) {
        throw new RangeError('maxChips must be a non-negative integer or Infinity.');
    }

    const element = document.createElement('div');
    element.className = 'sb-chip-entry';
    element.dataset.sbEditorField = field;
    const chips = document.createElement('ul');
    chips.className = 'sb-chip-entry__chips';
    chips.setAttribute('role', 'list');
    chips.setAttribute('aria-label', label);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sb-chip-entry__input';
    input.setAttribute('aria-label', label);
    input.placeholder = placeholder;
    element.append(chips, input);

    const datalist = suggestions ? document.createElement('datalist') : null;
    if (datalist) {
        datalist.id = `sb-chip-entry-suggestions-${++nextDatalistId}`;
        input.setAttribute('list', datalist.id);
        element.append(datalist);
    }

    let current = [];
    let suggestionValues = [];
    let disabled = false;

    function emit() {
        onChange?.([...current]);
    }

    function createChip(value) {
        const chip = document.createElement('li');
        chip.className = 'sb-chip';
        const extraClass = typeof chipClass === 'function' ? chipClass(value) : chipClass;
        if (extraClass) chip.classList.add(...extraClass.split(/\s+/).filter(Boolean));
        const text = document.createElement('span');
        text.className = 'sb-chip__label';
        text.textContent = chipLabel(value);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'sb-chip__remove';
        remove.setAttribute('aria-label', removeLabel(value));
        remove.disabled = disabled;
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-xmark';
        icon.setAttribute('aria-hidden', 'true');
        remove.append(icon);
        chip.append(text, remove);
        return chip;
    }

    function addValues(candidates) {
        const overflow = [];
        for (const candidate of candidates) {
            const value = normalize(candidate);
            if (!value || (!allowDuplicates && current.includes(value))) continue;
            if (current.length >= maxChips) {
                overflow.push(candidate);
                continue;
            }
            const chip = createChip(value);
            current.push(value);
            chips.append(chip);
            emit();
        }
        return overflow;
    }

    function commitText(text, complete) {
        const tokens = [...split(text)];
        let pending = '';
        if (!complete && tokens.length) {
            const last = tokens.at(-1);
            if (!text.trimEnd().endsWith(',') || last.trimEnd().endsWith(',')) pending = tokens.pop();
        }
        // No recognized delimiter: keep the exact text and caret, especially inside regexes.
        if (!complete && !tokens.length && pending) return;
        input.value = pending;
        const overflow = addValues(tokens);
        if (overflow.length) input.value = [...overflow, pending].filter(Boolean).join(', ');
    }

    function commitPending() {
        if (!disabled) commitText(input.value, true);
        return [...current];
    }

    function focusRemove(index) {
        const button = chips.children[index]?.querySelector('button');
        (button ?? input).focus();
    }

    function removeAt(index, moveFocus) {
        if (disabled || index < 0 || index >= current.length) return;
        current.splice(index, 1);
        chips.children[index].remove();
        if (moveFocus) focusRemove(Math.min(index, current.length - 1));
        emit();
    }

    function setValues(next, { silent = true } = {}) {
        const parsed = [];
        for (const candidate of next) {
            const value = normalize(candidate);
            if (!value || (!allowDuplicates && parsed.includes(value))) continue;
            if (parsed.length >= maxChips) break;
            parsed.push(value);
        }
        const rows = parsed.map(createChip);
        current = parsed;
        input.value = '';
        chips.replaceChildren(...rows);
        if (!silent) emit();
    }

    function refreshSuggestions() {
        if (!datalist || disabled) return;
        suggestionValues = [...new Set(suggestions())];
        datalist.replaceChildren(...suggestionValues.map(value => {
            const option = document.createElement('option');
            option.value = value;
            return option;
        }));
    }

    const onInput = event => {
        if (disabled || event.isComposing) return;
        // Datalist picks arrive as replacement text (Firefox omits inputType); typed characters never
        // commit, so typing "catfish" past the suggestion "cat" does not split the keyword.
        const picked = !event.inputType || event.inputType === 'insertReplacementText';
        if (picked && suggestionValues.includes(input.value)) {
            const value = input.value;
            input.value = '';
            input.value = addValues([value]).join(', ');
            return;
        }
        if (input.value.includes(',')) commitText(input.value, false);
    };

    const onInputKeydown = event => {
        if (disabled || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            commitPending();
            return;
        }
        if (event.key === ',') {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            // Insert at the selection before asking the caller's splitter whether this comma ends a token.
            input.setRangeText(',', start, end, 'end');
            event.preventDefault();
            commitText(input.value, false);
            return;
        }
        if (event.key === 'Escape' && input.value) {
            event.preventDefault();
            event.stopPropagation();
            input.value = '';
            return;
        }
        if (event.key === 'Backspace' && !input.value && current.length) {
            event.preventDefault();
            removeAt(current.length - 1, false);
            return;
        }
        if (event.key !== 'ArrowLeft' || event.shiftKey || input.selectionStart !== 0 || input.selectionEnd !== 0 || !current.length) return;
        event.preventDefault();
        commitPending();
        focusRemove(current.length - 1);
    };

    const onPaste = event => {
        if (disabled) return;
        const text = event.clipboardData?.getData('text/plain');
        if (!text?.includes(',')) return;
        event.preventDefault();
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
        commitPending();
    };

    const onChipClick = event => {
        const button = event.target.closest('.sb-chip__remove');
        if (!button || !chips.contains(button)) return;
        removeAt([...chips.children].indexOf(button.parentElement), true);
    };

    const onChipKeydown = event => {
        if (disabled || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const button = event.target.closest('.sb-chip__remove');
        if (!button || !chips.contains(button)) return;
        const index = [...chips.children].indexOf(button.parentElement);
        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            removeAt(index, true);
            return;
        }
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        focusRemove(event.key === 'ArrowLeft' ? Math.max(0, index - 1) : index + 1);
    };

    const onContainerClick = event => {
        if (!disabled && (event.target === element || event.target === chips)) input.focus();
    };
    const onBlur = () => commitPending();

    setValues(values);
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    input.addEventListener('paste', onPaste);
    input.addEventListener('blur', onBlur);
    input.addEventListener('focus', refreshSuggestions);
    chips.addEventListener('click', onChipClick);
    chips.addEventListener('keydown', onChipKeydown);
    element.addEventListener('click', onContainerClick);

    return {
        element,
        input,
        getValues: () => [...current],
        setValues,
        commitPending,
        getPending: () => input.value,
        focus: () => input.focus(),
        setDisabled(value) {
            disabled = Boolean(value);
            input.disabled = disabled;
            element.setAttribute('aria-disabled', String(disabled));
            for (const button of chips.querySelectorAll('button')) button.disabled = disabled;
        },
        destroy() {
            input.removeEventListener('input', onInput);
            input.removeEventListener('keydown', onInputKeydown);
            input.removeEventListener('paste', onPaste);
            input.removeEventListener('blur', onBlur);
            input.removeEventListener('focus', refreshSuggestions);
            chips.removeEventListener('click', onChipClick);
            chips.removeEventListener('keydown', onChipKeydown);
            element.removeEventListener('click', onContainerClick);
            input.removeAttribute('list');
            datalist?.remove();
        },
    };
}
