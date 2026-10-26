import { ownerFilterKey, parseOwnerFilter } from '../core.js';
import { button, el, tr } from './dom.js';
import { nextRenderId } from './render-id.js';
import { allRows, ownerLabel } from './rows.js';

export function ownerControl(ctx) {
    const id = `sbca_owner_${nextRenderId()}`;
    const wrap = el('div', 'sbca-owner-selector');
    const details = el('details', 'sbca-owner-details');
    const summary = el('summary', 'text_pole sbca-owner-summary');
    const summaryTextId = `${id}_value`;
    summary.setAttribute('aria-label', tr(ctx, 'Character or group'));
    const menu = el('div', 'sbca-owner-menu');
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'text_pole sbca-owner-search';
    search.placeholder = tr(ctx, 'Search characters and groups');
    search.setAttribute('aria-label', tr(ctx, 'Search characters and groups'));
    search.autocomplete = 'off';
    const list = el('div', 'sbca-owner-options');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', tr(ctx, 'Character or group'));
    const empty = el('p', 'sbca-owner-empty', tr(ctx, 'No characters or groups match.'));
    empty.hidden = true;
    const input = document.createElement('input');
    input.type = 'hidden';
    menu.append(search, list, empty);
    details.append(summary, menu);
    wrap.append(details, input);
    return { wrap, details, summary, summaryTextId, search, list, empty, input, choices: new Map() };
}

function ownerChoiceVisual(ctx, choice) {
    if (choice.avatar) {
        const image = document.createElement('img');
        image.className = 'sbca-owner-mini-avatar';
        image.src = ctx.getThumbnailUrl('avatar', choice.avatar);
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        return image;
    }
    const iconName = choice.kind === 'group'
        ? 'fa-users'
        : choice.kind === 'character'
            ? 'fa-user-slash'
            : 'fa-layer-group';
    const icon = el('i', `sbca-owner-mini-icon fa-solid ${iconName}`);
    icon.setAttribute('aria-hidden', 'true');
    return icon;
}

export function fallbackOwnerChoice(ctx, value) {
    const parsed = parseOwnerFilter(value);
    if (parsed) {
        return {
            value,
            label: parsed.id,
            meta: tr(ctx, parsed.kind === 'character' ? 'Character unavailable' : 'Group unavailable'),
            kind: parsed.kind,
            id: parsed.id,
            avatar: null,
        };
    }
    return {
        value,
        label: value || tr(ctx, 'All characters and groups'),
        meta: value ? tr(ctx, 'Saved filter') : '',
        kind: '',
        id: '',
        avatar: null,
    };
}

export function setOwnerValue(ctx, ui, value) {
    const selected = value ?? '';
    ui.owner.value = selected;
    const choice = ui.ownerField.choices.get(selected) ?? fallbackOwnerChoice(ctx, selected);
    const copy = el('span', 'sbca-owner-choice-copy');
    copy.id = ui.ownerField.summaryTextId;
    const name = el('span', 'sbca-owner-choice-name', choice.label);
    copy.append(name);
    ui.ownerField.summary.replaceChildren(ownerChoiceVisual(ctx, choice), copy);
    ui.ownerField.summary.setAttribute('aria-label', `${tr(ctx, 'Character or group')}: ${choice.label}`);
    for (const option of ui.ownerField.list.querySelectorAll('.sbca-owner-option')) {
        option.setAttribute('aria-pressed', String(option.dataset.sbcaOwner === selected));
    }
}

export function renderOwnerOptions(ctx, ui, choices, selected) {
    ui.ownerField.choices = new Map(choices.map(choice => [choice.value, choice]));
    ui.ownerField.list.replaceChildren();
    for (const choice of choices) {
        const option = button('sbca-owner-option');
        option.dataset.sbcaOwner = choice.value;
        option.dataset.sbcaSearch = `${choice.label} ${choice.meta} ${choice.id}`.toLocaleLowerCase();
        option.setAttribute('aria-label', choice.meta ? `${choice.label}, ${choice.meta}` : choice.label);
        option.append(ownerChoiceVisual(ctx, choice));
        const copy = el('span', 'sbca-owner-choice-copy');
        copy.append(el('span', 'sbca-owner-choice-name', choice.label));
        if (choice.meta) {
            copy.append(el('span', 'sbca-owner-choice-meta', choice.meta));
        }
        option.append(copy);
        const select = () => {
            const changed = ui.owner.value !== choice.value;
            setOwnerValue(ctx, ui, choice.value);
            ui.ownerField.details.open = false;
            ui.ownerField.summary.focus({ preventScroll: true });
            if (changed) {
                ui.owner.dispatchEvent(new Event('change', { bubbles: true }));
            }
        };
        // Mouse/pen commit on pointerdown: platforms that do not focus buttons
        // on press can lose the click when the focusout auto-close hides the
        // option first. Touch waits for click so scroll gestures that start on
        // an option are not mistaken for selection.
        option.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.pointerType === 'touch') {
                return;
            }
            select();
        });
        option.addEventListener('click', select);
        ui.ownerField.list.append(option);
    }
    setOwnerValue(ctx, ui, selected);
    filterOwnerOptions(ui);
}

export function filterOwnerOptions(ui) {
    const query = ui.ownerField.search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const option of ui.ownerField.list.querySelectorAll('.sbca-owner-option')) {
        option.hidden = !!query && !option.dataset.sbcaSearch.includes(query);
        visible += option.hidden ? 0 : 1;
    }
    ui.ownerField.empty.hidden = visible > 0;
}

export function refreshOwnerOptions(ctx, state, ui) {
    const current = ui.owner.value;
    const owners = new Map();
    for (const row of allRows(state)) {
        const value = ownerFilterKey(row);
        const identity = parseOwnerFilter(value);
        if (!identity) {
            continue;
        }
        const choice = {
            value,
            label: ownerLabel(ctx, row),
            meta: '',
            kind: identity.kind,
            id: identity.id,
            avatar: identity.kind === 'character' && row.kind === 'solo' ? row.avatar : null,
        };
        if (!owners.has(value) || (!owners.get(value).avatar && choice.avatar)) {
            owners.set(value, choice);
        }
    }
    const counts = new Map();
    for (const choice of owners.values()) {
        const name = choice.label.toLocaleLowerCase();
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const choice of owners.values()) {
        if (counts.get(choice.label.toLocaleLowerCase()) > 1) {
            choice.meta = tr(ctx, choice.kind === 'character' ? 'Character: {name}' : 'Group: {name}', { name: choice.id });
        }
    }
    const choices = [...owners.values()].sort((a, b) => (
        a.label.localeCompare(b.label)
        || a.kind.localeCompare(b.kind)
        || a.id.localeCompare(b.id)
    ));
    choices.unshift(fallbackOwnerChoice(ctx, ''));
    if (current && !owners.has(current)) {
        choices.push(fallbackOwnerChoice(ctx, current));
    }
    renderOwnerOptions(ctx, ui, choices, current);
}
