import { t } from '../i18n.js';
import { positionPopover } from '../sillybunny-action-menu.js';
import { MENU_SHEET_QUERY } from './breakpoints.js';
import { animateIn, animateOut, stopMotion, MOTION_FAST, MOTION_POPOVER_CLOSE, MOTION_EASE_OUT_CUBIC } from '../sillybunny-motion.js';
import { blockUpstreamDrawerClose, createSheetController } from '../sillybunny-sheet.js';
import { hostOverlayLayer, linkChildLayer } from './overlay-host.js';
import { createStatusPage } from './status-page.js';
import { detailsToText, renderDetails } from './option-details.js';
import { bindSheetSwipeClose, createSheetHandle } from './sheet-gestures.js';

let activePicker = null;
let pickerId = 0;
let mobileFrame = null;

function createId(prefix) {
    pickerId += 1;
    return `${prefix}-${pickerId}`;
}

/**
 * Hides or shows an element of a picker with a class, not with the `hidden` attribute. Changing `hidden` or an inline style
 * makes the browser restyle most of the page (the app has a few hundred `:has()` rules), which costs more on a phone than
 * the rest of a keystroke; a class that sets `display: none` costs nothing measurable.
 */
function setHidden(element, hidden) {
    element.classList.toggle('is-hidden', hidden);
}

function createIcon(icon, fallback = 'fa-solid fa-puzzle-piece') {
    if (typeof icon === 'function') {
        const made = /** @type {Element} */ (icon());
        made.removeAttribute('id');
        made.setAttribute('aria-hidden', 'true');
        return made;
    }
    if (icon instanceof Element) {
        const clone = /** @type {Element} */ (icon.cloneNode(true));
        clone.removeAttribute('id');
        clone.setAttribute('aria-hidden', 'true');
        return clone;
    }
    const element = document.createElement('i');
    element.className = icon || fallback;
    element.setAttribute('aria-hidden', 'true');
    return element;
}

function isMobileLayout() {
    return window.matchMedia(MENU_SHEET_QUERY).matches;
}

function setTriggerExpanded(trigger, expanded) {
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
        return;
    }
    trigger.removeAttribute('aria-controls');
}

function createSheetFrame() {
    if (mobileFrame) {
        if (!mobileFrame.element.isConnected) {
            document.body.append(mobileFrame.backdrop, mobileFrame.element);
        }
        return mobileFrame;
    }

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'sb-action-sheet-backdrop';
    backdrop.tabIndex = -1;
    backdrop.hidden = true;
    backdrop.setAttribute('aria-label', t`Close`);

    const element = document.createElement('div');
    element.className = 'sb-action-sheet sb-picker-sheet';
    element.hidden = true;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'sb-action-sheet-header';
    const heading = document.createElement('div');
    heading.className = 'sb-action-sheet-heading';
    const title = document.createElement('h2');
    title.className = 'sb-action-sheet-title';
    title.tabIndex = -1;
    heading.append(title);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sb-action-sheet-close';
    close.title = t`Close`;
    close.setAttribute('aria-label', t`Close`);
    close.append(createIcon('fa-solid fa-xmark'));
    close.addEventListener('click', () => closePicker({ restoreFocus: true }));
    header.append(heading, close);

    const body = document.createElement('div');
    body.className = 'sb-action-sheet-body';
    element.append(createSheetHandle(), header, body);
    document.body.append(backdrop, element);
    blockUpstreamDrawerClose(backdrop);
    blockUpstreamDrawerClose(element);

    const controller = createSheetController({
        sheet: element,
        backdrop,
        getInitialFocus: () => activePicker?.input ?? title,
        getReturnFocus: () => activePicker?.trigger?.isConnected ? activePicker.trigger : null,
        canAnimateClose: isMobileLayout,
        onClose: () => finishClose(),
    });
    bindSheetSwipeClose({ sheet: element, backdrop, headerSelector: '.sb-action-sheet-header', close: () => closePicker({ restoreFocus: true }) });
    mobileFrame = { backdrop, element, body, title, controller };
    return mobileFrame;
}

function createSeparator() {
    const separator = document.createElement('div');
    separator.className = 'sb-action-menu-separator sb-picker__separator';
    separator.setAttribute('role', 'separator');
    return separator;
}

function isLinkTarget(event, option) {
    const link = event.target instanceof Element ? event.target.closest('a') : null;
    return Boolean(link && option.contains(link));
}

/** The value of the item that creates what the search names. */
const CREATE_ITEM = Symbol('create');
/** The value of the row that shows the next batch of a list that is paged by `pageSize`. */
const SHOW_MORE = Symbol('show-more');
const SHOW_MORE_ITEM = Object.freeze({ value: SHOW_MORE, label: 'Show More' });

/** A picker that is built into a page has no popover or sheet, so it is live until it is destroyed. */
function isLive(state) {
    return state.kind === 'inline' ? !state.destroyed : activePicker === state;
}

/** A disabled item stays out of reach unless it is a selected item of a multiple picker, which can still be removed. */
function isItemDisabled(state, item, itemState = null) {
    return Boolean(item.disabled) && !(state.multiple && itemState === 'selected');
}

/** What a query is matched against. An item that carries `searchText` (in lower case) has it made once by its owner. */
function itemHaystack(item) {
    if (typeof item.searchText === 'string') return item.searchText;
    return `${item.label} ${item.subtitle ?? (item.details ? detailsToText(item.details) : '')} ${item.group ?? ''}`.toLocaleLowerCase();
}

function resetEntryOption(entry) {
    entry.option?.remove();
    entry.option = null;
    entry.check = null;
    entry.excluded = null;
    entry.stateKey = '';
    entry.visible = false;
}

/**
 * Wraps the items in entries that hold what is made once per item: the search key and the row. An item object that was
 * in the list before keeps its entry, so a refresh builds a row only for an item that changed.
 */
function setItems(state, items) {
    const previous = new Map((state.entries ?? []).map(entry => [entry.item, entry]));
    const entries = [];
    const entryByValue = new Map();
    let grouped = false;
    for (const item of items) {
        const entry = previous.get(item) ?? { item, key: itemHaystack(item), index: 0, option: null, check: null, excluded: null, stateKey: '', visible: false, lastShown: 0 };
        entry.index = entries.length;
        entries.push(entry);
        if (!entryByValue.has(item.value)) entryByValue.set(item.value, entry);
        if (item.group) grouped = true;
    }
    const kept = new Set(entries);
    for (const entry of state.entries ?? []) {
        if (!kept.has(entry) && entry.option) {
            resetEntryOption(entry);
        }
    }
    state.items = [...items];
    state.entries = entries;
    state.entryByValue = entryByValue;
    state.grouped = grouped;
    // Rows are retained and hidden only in a list that is not grouped and has no create item, which shows its matches in
    // item order, so that a row never has to move.
    state.paged = Number.isFinite(state.pageSize) && !grouped && !state.create;
    state.built = state.paged ? state.built.filter(entry => kept.has(entry)) : [];
    if (state.built.some((entry, position) => position > 0 && state.built[position - 1].index > entry.index)) {
        // The items changed their order, so the rows that are in the list are not in item order any more.
        for (const entry of state.built) {
            resetEntryOption(entry);
        }
        state.built = [];
    }
    pruneEmptyPages(state);
}

function createOption(state, item, id, onClick) {
    const option = document.createElement('li');
    option.id = id;
    option.className = 'sb-picker__option';
    option.setAttribute('role', 'option');
    if (item.ariaLabel) option.setAttribute('aria-label', item.ariaLabel);
    option.tabIndex = -1;
    // Keep pointer activation from moving the combobox's virtual focus onto a replaced option or a link inside one.
    // A link still opens: this only stops the press from taking focus.
    option.addEventListener('mousedown', event => {
        if (state.multiple || isLinkTarget(event, option)) event.preventDefault();
    });
    if (item.icon) {
        option.append(createIcon(item.icon));
    }

    const text = document.createElement('span');
    text.className = 'sb-picker__option-text';
    const label = document.createElement('span');
    label.className = 'sb-picker__label';
    label.textContent = item.label;
    text.append(label);
    const subtitleText = item.subtitle ?? (item.details ? detailsToText(item.details) : '');
    if (subtitleText || item.details?.length) {
        const subtitle = document.createElement('span');
        subtitle.className = 'sb-picker__subtitle';
        if (item.details?.length) {
            // The plain text above is what search matches; the elements keep icons, links and tooltips.
            subtitle.classList.add('sb-picker__subtitle--details');
            subtitle.append(renderDetails(item.details));
            // A link needs room around it for a touch target, which a clamped subtitle would cut off.
            if (subtitle.querySelector('a')) subtitle.classList.add('sb-picker__subtitle--linked');
        } else {
            subtitle.textContent = subtitleText;
        }
        text.append(subtitle);
    }
    option.append(text);
    // A press on a link in the option's details follows the link and does not choose the option.
    option.addEventListener('click', event => {
        if (!isLinkTarget(event, option)) onClick(event);
    });
    return option;
}

/**
 * Writes what depends on the selection into a row: the selected mark, the minus of an excluded item, dimming and
 * disabling. A row whose state did not change is not written, so picking an item touches that row and no other.
 */
function syncOption(state, entry) {
    const { item, option } = entry;
    const itemState = state.multiple ? (state.getItemState?.(item.value) ?? null) : null;
    const selected = state.multiple ? itemState === 'selected' : Object.is(item.value, state.selected);
    const disabled = isItemDisabled(state, item, itemState);
    const stateKey = `${selected}|${itemState}|${disabled}`;
    if (entry.stateKey === stateKey) return;
    entry.stateKey = stateKey;

    option.setAttribute('aria-selected', String(selected));
    if (disabled) option.setAttribute('aria-disabled', 'true');
    else option.removeAttribute('aria-disabled');
    option.classList.toggle('is-disabled', disabled);
    if (state.multiple) {
        // A removable item that does not apply is dimmed like a muted one, without being announced as unavailable.
        option.classList.toggle('is-muted', Boolean(item.muted) || (Boolean(item.disabled) && !disabled));
    }
    if (state.paged) {
        // A pick must not insert an element: any insertion restyles the page, which costs more than the pick itself.
        setHidden(entry.check, !selected);
    } else if (selected && !entry.check) {
        entry.check = createIcon('fa-solid fa-check');
        entry.check.classList.add('sb-picker__check');
        option.append(entry.check);
    } else if (!selected && entry.check) {
        entry.check.remove();
        entry.check = null;
    }
    if (state.multiple && itemState === 'excluded' && !entry.excluded) {
        const minus = createIcon('fa-solid fa-minus');
        minus.classList.add('sb-picker__check', 'sb-picker__excluded');
        const label = document.createElement('span');
        label.className = 'sr-only';
        label.textContent = t`Not Selected`;
        entry.excluded = [minus, label];
        option.append(minus, label);
    } else if (itemState !== 'excluded' && entry.excluded) {
        for (const node of entry.excluded) node.remove();
        entry.excluded = null;
    }
}

/** Builds the row of an entry the first time it is shown. A row is kept for every later render. */
function ensureOption(state, entry) {
    if (entry.option) return entry.option;
    entry.option = createOption(state, entry.item, createId('sb-picker-option'), () => selectPickerItem(state, entry.item.value));
    if (state.paged) {
        entry.check = createIcon('fa-solid fa-check');
        entry.check.classList.add('sb-picker__check', 'is-hidden');
        entry.option.append(entry.check);
    }
    return entry.option;
}

function getEntryOption(state, entry) {
    ensureOption(state, entry);
    syncOption(state, entry);
    return entry.option;
}

/**
 * A page is one element that holds rows. Rows are added to the list as one page at a time, so that the observers of the
 * app (keyboard.js and a11y.js scan every element that is added) look at one element and not at fifty rows.
 * `display: contents` keeps the rows laid out as direct children of the list.
 */
function createPage(options) {
    const element = document.createElement('li');
    element.className = 'sb-picker__page';
    element.setAttribute('role', 'presentation');
    const inner = document.createElement('ul');
    inner.setAttribute('role', 'presentation');
    inner.append(...options);
    element.append(inner);
    return element;
}

function pruneEmptyPages(state) {
    if (!state.list) return;
    for (const page of [...state.list.querySelectorAll(':scope > .sb-picker__page')]) {
        if (!page.firstElementChild.firstElementChild) page.remove();
    }
}

function getShowMoreOption(state) {
    if (!state.moreOption) {
        const option = document.createElement('li');
        option.id = createId('sb-picker-option');
        option.className = 'sb-picker__option sb-picker__more';
        // No aria-selected: the row cannot be selected, and a multiple listbox would read it as "not selected".
        option.setAttribute('role', 'option');
        option.tabIndex = -1;
        option.textContent = t`Show More`;
        // The search field keeps the focus, as it does for a multiple picker's options.
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('click', () => selectPickerItem(state, SHOW_MORE));
        state.moreOption = option;
    }
    return state.moreOption;
}

function createFilterControls(state, input) {
    const { label, items } = state.filter;
    const row = document.createElement('div');
    row.className = 'sb-picker__search-row';

    const panel = document.createElement('div');
    panel.className = 'sb-picker__filters';
    panel.id = createId('sb-picker-filters');
    panel.classList.add('is-hidden');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', label);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sb-picker__filter-toggle';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', panel.id);
    const badge = document.createElement('span');
    badge.className = 'sb-picker__filter-count';
    badge.classList.add('is-hidden');
    toggle.append(createIcon('fa-solid fa-tags'), badge);
    row.append(input, toggle);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'sb-picker__filter-clear';
    clear.textContent = t`Clear All Filters`;
    clear.classList.add('is-hidden');

    const chips = new Map();
    for (const item of items) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'sb-picker__chip';
        chip.setAttribute('aria-pressed', 'false');
        const dot = document.createElement('span');
        dot.className = 'sb-picker__chip-dot';
        dot.style.backgroundColor = item.color || 'var(--sb-muted-fg)';
        dot.setAttribute('aria-hidden', 'true');
        chip.append(dot, item.label);
        chip.addEventListener('click', () => {
            if (state.filterSelected.has(item.value)) state.filterSelected.delete(item.value);
            else state.filterSelected.add(item.value);
            syncFilterControls(state);
            applyPickerSearch(state);
        });
        chips.set(item.value, chip);
        panel.append(chip);
    }
    panel.append(clear);

    toggle.addEventListener('click', () => {
        setHidden(panel, !panel.classList.contains('is-hidden'));
        toggle.setAttribute('aria-expanded', String(!panel.classList.contains('is-hidden')));
        scheduleReposition(state);
    });
    clear.addEventListener('click', () => {
        state.filterSelected.clear();
        syncFilterControls(state);
        applyPickerSearch(state);
    });
    state.filterControls = { panel, toggle, badge, clear, chips };
    return { row, panel };
}

function syncFilterControls(state) {
    const { badge, clear, chips } = state.filterControls;
    const count = state.filterSelected.size;
    badge.textContent = String(count);
    setHidden(badge, !count);
    setHidden(clear, !count);
    state.filterControls.toggle.classList.toggle('is-active', count > 0);
    for (const [value, chip] of chips) chip.setAttribute('aria-pressed', String(state.filterSelected.has(value)));
}

function buildPickerContent(state, body) {
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'sb-picker__search';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-label', state.searchLabel);
    input.placeholder = state.searchPlaceholder;
    input.id = createId('sb-picker-search');

    const list = document.createElement('ul');
    list.className = 'sb-picker__list';
    list.setAttribute('role', 'listbox');
    if (state.multiple) list.setAttribute('aria-multiselectable', 'true');
    list.id = createId('sb-picker-list');
    list.setAttribute('aria-label', state.title);
    input.setAttribute('aria-controls', list.id);
    state.input = input;
    state.list = list;
    if (state.filter) {
        const { row, panel } = createFilterControls(state, input);
        body.replaceChildren(row, panel, list);
    } else {
        body.replaceChildren(input, list);
    }

    if (state.multiple && state.selectionCount) {
        const count = document.createElement('div');
        count.className = 'sb-picker__count';
        count.setAttribute('role', 'status');
        count.setAttribute('aria-live', 'polite');
        body.append(count);
        state.countElement = count;
    }

    const footer = document.createElement('div');
    footer.className = 'sb-picker__footer';
    state.footer.forEach((item, index) => {
        if (index === 0) {
            body.append(createSeparator());
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sb-action-menu-item sb-picker__footer-item';
        button.append(createIcon(item.icon), Object.assign(document.createElement('span'), {
            className: 'sb-action-menu-label',
            textContent: item.label,
        }));
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) return;
            closePicker({ restoreFocus: true });
            item.onSelect?.();
        });
        footer.append(button);
        state.footerButtons.push(button);
    });
    if (state.footer.length) {
        body.append(footer);
    }
    syncFooter(state);
    syncSelectionCount(state);
}

/**
 * Writes the count only when its text changes, so a live region announces a pick and not a re-render. The text node is
 * changed in place: `textContent` replaces it, and a replaced node restyles most of the page, which costs more than a pick.
 */
function syncSelectionCount(state) {
    const text = state.countElement ? String(state.selectionCount()) : '';
    if (!state.countElement || state.countElement.textContent === text) return;
    if (state.countElement.firstChild instanceof Text) state.countElement.firstChild.data = text;
    else state.countElement.textContent = text;
}

/** A footer action can be unavailable while the picker's own selection says so, such as a group that is too small. */
function syncFooter(state) {
    state.footer.forEach((item, index) => {
        const button = state.footerButtons[index];
        if (!button) return;
        const disabled = typeof item.disabled === 'function' ? Boolean(item.disabled()) : Boolean(item.disabled);
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
    });
}

/** Groups entries by the `group` label of their item in first-appearance order; ungrouped items form their own bucket. */
function groupBuckets(entries) {
    const buckets = new Map();
    for (const entry of entries) {
        const key = entry.item.group || null;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(entry);
    }
    return [...buckets];
}

function createGroup(label, options) {
    const wrapper = document.createElement('li');
    wrapper.className = 'sb-picker__group-item';
    wrapper.setAttribute('role', 'presentation');
    const heading = document.createElement('div');
    heading.className = 'sb-picker__group-heading';
    heading.setAttribute('role', 'presentation');
    heading.id = createId('sb-picker-group');
    heading.textContent = label;
    const group = document.createElement('ul');
    group.className = 'sb-picker__group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', heading.id);
    group.append(...options);
    wrapper.append(heading, group);
    return wrapper;
}

/**
 * Makes the children of `parent` the wanted nodes, in order, and moves, adds or removes only what differs. Replacing all
 * children would give the app-wide keyboard observer every row to scan again, which is the larger part of a render's cost.
 */
function reconcileChildren(parent, wanted) {
    let cursor = parent.firstChild;
    for (const node of wanted) {
        if (node === cursor) {
            cursor = cursor.nextSibling;
        } else {
            parent.insertBefore(node, cursor);
        }
    }
    while (cursor) {
        const next = cursor.nextSibling;
        cursor.remove();
        cursor = next;
    }
}

function getEmptyState(state, searched) {
    if (state.emptyElement?.searched !== searched) {
        const element = document.createElement('li');
        element.className = 'sb-picker__empty';
        element.setAttribute('role', 'presentation');
        // HUMAN: replace — a title that names the state in header capitalisation ("No Results"); the callers supply `emptyText`.
        element.append(createStatusPage({ state: searched ? 'no-results' : 'empty', title: state.emptyText, description: searched ? t`Try a different search` : undefined, compact: true }).element);
        state.emptyElement = { searched, element };
    }
    return state.emptyElement.element;
}

/** The entries that the query and the filter keep, in the order of the items. */
function matchEntries(state, query) {
    const filter = state.filter && state.filterSelected.size ? state.filter.match : null;
    if (!query && !filter) return state.entries;
    return state.entries.filter(entry => (!query || entry.key.includes(query)) && (!filter || filter(entry.item, state.filterSelected)));
}

function renderOptions(state) {
    clearTimeout(state.searchTimer);
    state.searchTimer = 0;
    const query = state.input.value.toLocaleLowerCase();
    // A new query or filter starts again at the first batch, the first match and the top of the list.
    const signature = `${query}\u0000${[...state.filterSelected].join('\u0000')}`;
    const restarted = state.signature !== undefined && state.signature !== signature;
    state.signature = signature;
    if (restarted) {
        state.pages = 1;
        state.activeIndex = 0;
        // Written before the rows change, while the layout of the old rows is still clean. Written after, the write forces
        // style and layout of every new row inside the key handler.
        state.list.scrollTop = 0;
        if (state.multiple && state.surface) state.surface.scrollTop = 0;
    }

    const matches = matchEntries(state, query);
    if (state.paged) {
        renderPagedOptions(state, matches);
        return;
    }
    const shown = matches;
    const buckets = state.grouped ? groupBuckets(shown) : [[null, shown]];
    // A query that names no item exactly can become one: the item leads the list, under its own words.
    const typed = state.input.value.trim();
    const createItem = state.create && typed && !state.items.some(item => item.label.toLocaleLowerCase() === typed.toLocaleLowerCase())
        ? { value: CREATE_ITEM, label: typed, icon: 'fa-solid fa-plus', ariaLabel: state.create.label?.(typed) }
        : null;

    // Keyboard order follows the visual order: the create item, then the grouped or plain matches.
    state.filtered = [
        ...(createItem ? [createItem] : []),
        ...buckets.flatMap(([, entries]) => entries.map(entry => entry.item)),
    ];
    state.activeIndex = state.filtered.length ? Math.max(0, Math.min(state.activeIndex, state.filtered.length - 1)) : -1;
    syncFooter(state);
    syncSelectionCount(state);

    if (!state.filtered.length) {
        state.activeOption?.classList.remove('is-active');
        state.activeOption = null;
        state.options = [];
        state.rendered = [];
        reconcileChildren(state.list, [getEmptyState(state, state.items.length > 0)]);
        state.input.removeAttribute('aria-activedescendant');
        return;
    }

    const options = [];
    const nodes = [];
    state.rendered = [];
    if (createItem) {
        const option = createOption(state, createItem, createId('sb-picker-option'), () => selectPickerItem(state, CREATE_ITEM));
        option.setAttribute('aria-selected', 'false');
        options.push(option);
        nodes.push(option);
    }
    for (const [label, entries] of buckets) {
        const bucketOptions = entries.map(entry => {
            state.rendered.push(entry);
            return getEntryOption(state, entry);
        });
        options.push(...bucketOptions);
        if (label !== null) nodes.push(createGroup(label, bucketOptions));
        else nodes.push(...bucketOptions);
    }
    const active = options[state.activeIndex];
    // Only the row that was active can still carry the class, and rewriting a class that does not change is a mutation.
    if (state.activeOption !== active) {
        state.activeOption?.classList.remove('is-active');
        active?.classList.add('is-active');
        state.activeOption = active ?? null;
    }
    state.options = options;
    reconcileChildren(state.list, nodes);
    if (active) {
        state.input.setAttribute('aria-activedescendant', active.id);
    }
}

/** Hidden rows that a paged list keeps before the oldest of them are removed, and how many it keeps after that. */
const RETAINED_ROWS_LIMIT = 600;
const RETAINED_ROWS_KEPT = 300;

/**
 * Adds the rows that were never built, each run of them as one page placed where its items belong. A row is inserted
 * only once; every later render shows or hides it, which changes an attribute and nothing in the tree.
 */
function insertFreshRows(state, fresh) {
    if (!fresh.length) return;
    const groups = [];
    let position = 0;
    for (const entry of fresh) {
        while (position < state.built.length && state.built[position].index < entry.index) position += 1;
        const next = state.built[position] ?? null;
        const last = groups.at(-1);
        if (last && last.next === next) last.options.push(entry.option);
        else groups.push({ next, options: [entry.option] });
    }
    for (const { next, options } of groups) {
        if (next && next.option.previousElementSibling !== null) {
            // The gap is inside a page, so the rows join that page, before the row that follows them.
            next.option.before(...options);
        } else {
            state.list.insertBefore(createPage(options), next ? next.option.parentElement.parentElement : state.moreOption);
        }
    }
    state.built = [...state.built, ...fresh].sort((a, b) => a.index - b.index);
}

/** A list that keeps many hidden rows costs memory and style work, so the rows that were shown longest ago are removed. */
function evictRetainedRows(state) {
    if (state.built.length <= RETAINED_ROWS_LIMIT) return;
    const hidden = state.built.filter(entry => !entry.visible).sort((a, b) => a.lastShown - b.lastShown);
    const evicted = new Set(hidden.slice(0, state.built.length - RETAINED_ROWS_KEPT));
    for (const entry of evicted) {
        resetEntryOption(entry);
    }
    state.built = state.built.filter(entry => !evicted.has(entry));
    pruneEmptyPages(state);
}

function getPagedEmptyState(state, searched) {
    const key = searched ? 'searched' : 'empty';
    if (!state.emptyStates[key]) {
        const element = document.createElement('li');
        element.className = 'sb-picker__empty';
        element.setAttribute('role', 'presentation');
        element.append(createStatusPage({ state: searched ? 'no-results' : 'empty', title: state.emptyText, description: searched ? t`Try a different search` : undefined, compact: true }).element);
        state.emptyStates[key] = element;
        state.list.insertBefore(element, state.moreOption);
    }
    return state.emptyStates[key];
}

/**
 * The render of a list that is paged: the first `pageSize` matches, and a Show More row for the next batch. A row that
 * was built stays in the list, hidden when it is not shown, because adding or removing a node restyles the page and a
 * change of a class does not. Filtering and clearing the search therefore touch no node of the tree except for rows that
 * were never built.
 */
function renderPagedOptions(state, matches) {
    state.renderCount += 1;
    const limit = state.pageSize * state.pages;
    const shown = matches.length > limit ? matches.slice(0, limit) : matches;
    const hasMore = shown.length < matches.length;
    state.filtered = [...shown.map(entry => entry.item), ...(hasMore ? [SHOW_MORE_ITEM] : [])];
    state.activeIndex = state.filtered.length ? Math.max(0, Math.min(state.activeIndex, state.filtered.length - 1)) : -1;
    syncFooter(state);
    syncSelectionCount(state);

    const more = getShowMoreOption(state);
    if (!more.isConnected) state.list.append(more);
    const fresh = [];
    for (const entry of shown) {
        entry.lastShown = state.renderCount;
        if (entry.option) continue;
        ensureOption(state, entry);
        entry.visible = true;
        fresh.push(entry);
    }
    insertFreshRows(state, fresh);
    const wanted = new Set(shown);
    for (const entry of state.built) {
        const visible = wanted.has(entry);
        if (visible) syncOption(state, entry);
        if (entry.visible !== visible) {
            entry.visible = visible;
            setHidden(entry.option, !visible);
        }
    }
    setHidden(more, !hasMore);
    const noMatch = shown.length === 0;
    const searched = state.items.length > 0;
    for (const [key, element] of Object.entries(state.emptyStates)) setHidden(element, !noMatch || (key === 'searched') !== searched);
    if (noMatch) setHidden(getPagedEmptyState(state, searched), false);

    state.rendered = shown;
    state.options = [...shown.map(entry => entry.option), ...(hasMore ? [more] : [])];
    const active = state.options[state.activeIndex];
    if (state.activeOption !== active) {
        state.activeOption?.classList.remove('is-active');
        active?.classList.add('is-active');
        state.activeOption = active ?? null;
    }
    if (active) state.input.setAttribute('aria-activedescendant', active.id);
    else state.input.removeAttribute('aria-activedescendant');
    evictRetainedRows(state);
}

/** Makes the rows that are on the screen show the picker's selection as it is now, without building or moving any. */
function syncRenderedStates(state) {
    for (const entry of state.rendered) syncOption(state, entry);
    syncFooter(state);
    syncSelectionCount(state);
}

function showMore(state) {
    // Show More was the last row, so the first row that the batch adds takes its place in the order.
    state.activeIndex = Math.max(0, state.filtered.length - 1);
    state.pages += 1;
    renderOptions(state);
    updateActiveOption(state, state.activeIndex);
    scheduleReposition(state);
}

function selectPickerItem(state, value) {
    if (!isLive(state)) {
        return;
    }
    if (value === SHOW_MORE) {
        showMore(state);
        return;
    }
    if (value === CREATE_ITEM) {
        const typed = state.input.value.trim();
        state.input.value = '';
        try {
            state.create.onCreate(typed);
        } finally {
            if (isLive(state)) {
                if (state.multiple || state.kind === 'inline') applyPickerSearch(state);
                else closePicker({ restoreFocus: true });
            }
        }
        return;
    }
    const item = state.entryByValue.get(value)?.item;
    if (item && isItemDisabled(state, item, state.multiple ? state.getItemState?.(value) : null)) {
        return;
    }
    try {
        state.onSelect?.(value);
    } finally {
        if (isLive(state)) {
            if (state.multiple || state.kind === 'inline') syncRenderedStates(state);
            else closePicker({ restoreFocus: true });
        }
    }
}

function updateActiveOption(state, nextIndex) {
    if (!state.filtered.length) {
        return;
    }
    state.activeIndex = Math.max(0, Math.min(nextIndex, state.filtered.length - 1));
    const active = state.options[state.activeIndex];
    if (state.activeOption && state.activeOption !== active) state.activeOption.classList.remove('is-active');
    state.activeOption = active ?? null;
    if (!active) {
        state.input.removeAttribute('aria-activedescendant');
        return;
    }
    active.classList.add('is-active');
    state.input.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView?.({ block: 'nearest' });
}

function handlePickerKeydown(state, event) {
    if (!isLive(state) || event.isComposing) {
        return;
    }
    if (event.key === 'Escape') {
        // A picker in a page leaves Escape to the page's own window.
        if (state.kind === 'inline') return;
        event.preventDefault();
        event.stopPropagation();
        closePicker({ restoreFocus: true });
        return;
    }
    if (event.target !== state.input) {
        return;
    }
    if (state.searchTimer && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) {
        applyPickerSearch(state);
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        const next = event.key === 'Home' ? 0
            : event.key === 'End' ? state.filtered.length - 1
                : state.activeIndex + step;
        updateActiveOption(state, next);
        return;
    }
    if (event.key === 'Enter' && state.filtered[state.activeIndex]) {
        event.preventDefault();
        event.stopPropagation();
        selectPickerItem(state, state.filtered[state.activeIndex].value);
    }
}

function applyPickerSearch(state) {
    if (!isLive(state)) return;
    state.activeIndex = 0;
    state.pages = 1;
    renderOptions(state);
    scheduleReposition(state);
}

function handlePickerInput(state) {
    if (!isLive(state)) return;
    clearTimeout(state.searchTimer);
    if (!state.input.value || state.searchDelay === 0) {
        applyPickerSearch(state);
        return;
    }
    state.searchTimer = setTimeout(() => applyPickerSearch(state), state.searchDelay);
}

/**
 * Places the popover again once per frame, and only when the number of rows or the filter panel changed its height.
 * Reading the geometry after every render forces layout of every row that was just added.
 */
function positionKeyOf(state) {
    return `${state.options.length}|${state.filterControls?.panel.classList.contains('is-hidden') ?? ''}`;
}

function scheduleReposition(state) {
    if (state.kind !== 'popover' || state.positionPending) return;
    const key = positionKeyOf(state);
    if (key === state.positionKey) return;
    state.positionPending = true;
    requestAnimationFrame(() => {
        state.positionPending = false;
        if (activePicker !== state) return;
        state.positionKey = key;
        handleResize();
    });
}

/** A press on the owner itself, not on another control inside it (a row's menu button still dismisses). */
function isOwnerBackground(state, target) {
    if (!state.owner.contains(target)) return false;
    const control = target instanceof Element ? target : target.parentElement;
    const inner = control?.closest('button, a, input, select, textarea, [role="button"], [tabindex]');
    return !inner || !state.owner.contains(inner) || inner === state.owner;
}

function handleOutsidePointerDown(event) {
    const state = activePicker;
    if (!state || state.kind !== 'popover') {
        return;
    }
    const target = event.target instanceof Node ? event.target : null;
    if (target && isOwnerBackground(state, target)) {
        // Keep focus inside until the owner's click toggles us; a focusable ancestor otherwise closes us first.
        event.preventDefault();
        return;
    }
    if (target && (state.surface.contains(target) || state.trigger.contains(target))) {
        return;
    }
    closePicker();
}

function handleResize() {
    const state = activePicker;
    if (!state || state.kind !== 'popover') {
        return;
    }
    // Reading scrollTop forces layout of every row, so only a picker that restores it reads it.
    const scrollTop = state.multiple ? state.surface.scrollTop : 0;
    if (state.matchTriggerWidth) {
        const bounds = state.bounds?.getBoundingClientRect();
        const available = bounds?.width > 0
            ? Math.min(bounds.right, window.innerWidth) - Math.max(bounds.left, 0) - 16
            : window.innerWidth - 16;
        // Measured once with every option rendered, so filtering never resizes the popover.
        if (state.contentWidth === undefined) {
            state.surface.style.inlineSize = 'max-content';
            state.surface.style.maxInlineSize = 'none';
            // max-content leaves out the list's scrollbar, which would then push the widest label onto a second line.
            const list = state.surface.querySelector('.sb-picker__list');
            const scrollbar = list ? Math.max(0, list.offsetWidth - list.clientWidth) : 0;
            // scrollWidth leaves out the borders, which border-box sizing counts; the box width includes them.
            const box = state.surface.getBoundingClientRect().width || 0;
            state.contentWidth = Math.ceil(Math.max(box, state.surface.scrollWidth || 0) + scrollbar);
        }
        const wanted = Math.max(320, state.trigger.getBoundingClientRect().width, state.contentWidth);
        const width = Math.max(0, Math.min(560, wanted, available));
        state.surface.style.inlineSize = `${width}px`;
        state.surface.style.maxInlineSize = `${width}px`;
        state.origin = positionPopover(state.surface, state.trigger, null, state.bounds, 'start');
    } else {
        state.origin = positionPopover(state.surface, state.trigger, null, state.bounds);
    }
    state.surface.style.transformOrigin = state.origin;
    if (state.multiple) state.surface.scrollTop = scrollTop;
}

function finishClose() {
    const state = activePicker;
    if (!state) {
        return;
    }
    activePicker = null;
    clearTimeout(state.searchTimer);
    state.positionPending = false;
    state.removeContentListeners?.();
    state.removeParentListener?.();
    window.removeEventListener('resize', handleResize);
    document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    state.input.setAttribute('aria-expanded', 'false');
    setTriggerExpanded(state.trigger, false);
    if (state.restoreFocus && state.trigger.isConnected) {
        state.trigger.focus({ preventScroll: true });
    }
    state.onClose?.();
}

/**
 * Everything that a picker keeps between renders. A popover, a sheet and a picker that is built into a page differ only in
 * `kind`, so the list, the search and the keys are one implementation.
 */
function createPickerState({
    trigger = null,
    owner = null,
    title = '',
    items,
    selected = null,
    multiple = false,
    getItemState = null,
    onSelect,
    footer = [],
    selectionCount = null,
    searchLabel = t`Search`,
    searchPlaceholder = searchLabel,
    emptyText = t`No Results`,
    bounds = null,
    matchTriggerWidth = false,
    onClose = null,
    create = null,
    pageSize = Infinity,
    searchDelay = 300,
    filter = null,
    kind,
}) {
    const state = {
        trigger,
        owner,
        title,
        items: [],
        entries: [],
        entryByValue: new Map(),
        grouped: false,
        selected,
        multiple,
        getItemState,
        onSelect,
        footer: [...footer],
        footerButtons: [],
        selectionCount: typeof selectionCount === 'function' ? selectionCount : null,
        countElement: null,
        searchLabel,
        searchPlaceholder,
        emptyText,
        bounds,
        matchTriggerWidth,
        onClose,
        create,
        pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : Infinity,
        pages: 1,
        paged: false,
        searchDelay: 300,
        filter: filter && Array.isArray(filter.items) && filter.items.length && typeof filter.match === 'function' ? filter : null,
        filterSelected: new Set(),
        filterControls: null,
        restoreFocus: true,
        input: null,
        list: null,
        filtered: [],
        options: [],
        rendered: [],
        built: [],
        renderCount: 0,
        emptyStates: {},
        activeOption: null,
        activeIndex: 0,
        searchTimer: 0,
        signature: undefined,
        positionKey: '',
        positionPending: false,
        destroyed: false,
        surface: null,
        kind,
        removeParentListener: null,
    };
    state.searchDelay = Number.isFinite(searchDelay) && searchDelay >= 0 ? searchDelay : 300;
    setItems(state, items);
    return state;
}

/**
 * Builds a picker's search field and list into an element that the caller owns, such as the body of a page of a window.
 * It has no trigger, takes no part in the one-picker-at-a-time rule and leaves Escape to the page; the options are those
 * of `openPicker` that apply to its content (`footer` is not drawn).
 * @param {HTMLElement} host
 * @param {Omit<Parameters<typeof openPicker>[0], 'trigger'>} options
 * @returns {{ input: HTMLInputElement, list: HTMLElement, refresh: (items: object[]) => void, focusSearch: () => void, destroy: () => void }}
 */
export function mountPicker(host, options) {
    if (!(host instanceof HTMLElement) || !Array.isArray(options?.items) || typeof options.onSelect !== 'function') {
        throw new TypeError('mountPicker requires a host element, items, and an onSelect callback');
    }
    const state = createPickerState({ ...options, footer: [], kind: 'inline' });
    state.surface = host;
    buildPickerContent(state, host);
    const onKeydown = event => handlePickerKeydown(state, event);
    const onInput = () => handlePickerInput(state);
    state.input.addEventListener('keydown', onKeydown);
    state.input.addEventListener('input', onInput);
    renderOptions(state);
    return {
        input: state.input,
        list: state.list,
        refresh: items => {
            if (state.destroyed) return;
            if (!Array.isArray(items)) throw new TypeError('Picker items must be an array.');
            setItems(state, items);
            renderOptions(state);
        },
        focusSearch: () => state.input.focus({ preventScroll: true }),
        destroy: () => {
            state.destroyed = true;
            clearTimeout(state.searchTimer);
            state.input.removeEventListener('keydown', onKeydown);
            state.input.removeEventListener('input', onInput);
        },
    };
}

/**
 * Opens a searchable value picker. Opening it again from the same trigger toggles it closed.
 * @param {object} options
 * @param {HTMLElement} options.trigger
 * @param {string} options.title
 * @param {{ value: unknown, label: string, subtitle?: string, details?: import('./option-details.js').Details, group?: string, disabled?: boolean, icon?: string|Element|(() => Element), muted?: boolean, searchText?: string }[]} options.items
 *     Items with a `group` render under that heading, groups in first-appearance order; search also matches it.
 *     `details` (see option-details.js) replace the subtitle's text with elements such as icons; `subtitle` stays their plain text.
 *     A disabled item cannot be chosen, except that a selected one in a `multiple` picker can be removed.
 *     An `icon` function is called once, when the row is first built, so a long list does not make an element per item up front.
 *     `searchText`, in lower case, is what a query is matched against instead of the label, subtitle and group.
 * @param {unknown} [options.selected=null]
 * @param {boolean} [options.multiple=false] Toggle values without closing or changing search focus.
 * @param {(value: unknown) => 'selected'|'excluded'|null} [options.getItemState=null]
 *     Read again for the rows on the screen after each pick, which updates those rows in place.
 * @param {(value: unknown) => void} options.onSelect
 * @param {{ label: string, icon?: string|Element, onSelect: () => void, disabled?: boolean|(() => boolean) }[]} [options.footer=[]]
 *     A `disabled` function is read again after every selection change.
 * @param {(() => string)|null} [options.selectionCount=null] A `multiple` picker shows this text under the list, read again after
 *     every selection change and announced politely.
 * @param {number} [options.pageSize=Infinity] Shows this many matches, then a Show More row that adds as many. A new query or
 *     filter starts again at the first batch. A list with groups or a `create` item shows every match and ignores it. Rows that
 *     were built stay in the list and are hidden with a class, so a test of the rows that are shown reads `.is-hidden`.
 * @param {number} [options.searchDelay=300] Milliseconds after the last key before the list filters. 0 filters on every key,
 *     which a list that is paged by `pageSize` can afford.
 * @param {{ label: string, items: { value: string, label: string, color?: string }[], match: (item: object, selected: ReadonlySet<string>) => boolean }|null} [options.filter=null]
 *     A button beside the search field opens a panel of toggle chips. While any is on, only the items that `match` the
 *     selected chip values are listed.
 * @param {string} [options.searchLabel] The accessible name of the search field.
 * @param {string} [options.searchPlaceholder] The hint in the empty field; defaults to `searchLabel`. A label takes header
 *     capitalisation and a placeholder takes sentence capitalisation, so a label of several words needs its own form here.
 * @param {string} [options.emptyText]
 * @param {Element|null} [options.bounds=null]
 * @param {boolean} [options.matchTriggerWidth=false] Desktop: match the trigger up to 560px and align inline-start.
 * @param {boolean} [options.renderAsPopover=false] Keep a nested picker in the current modal on mobile.
 * @param {() => void|null} [options.onClose=null]
 * @param {HTMLElement|null} [options.owner=null] Element around the trigger (such as its row) whose presses
 *     do not dismiss the popover, so the owner can toggle it closed itself.
 * @param {{ onCreate: (text: string) => void, label?: (text: string) => string }|null} [options.create=null] A search that names no
 *     item exactly offers an item, the typed words with a plus, that calls `onCreate` with them; `label` names it for assistive
 *     technology. The search clears after it.
 * @returns {{ close: () => void, refresh: (items?: object[]) => void, readonly isOpen: boolean }}
 */
export function openPicker({
    trigger,
    title,
    items,
    selected = null,
    multiple = false,
    getItemState = null,
    onSelect,
    footer = [],
    selectionCount = null,
    searchLabel = t`Search`,
    searchPlaceholder = searchLabel,
    emptyText = t`No Results`,
    bounds = null,
    matchTriggerWidth = false,
    renderAsPopover = false,
    onClose = null,
    owner = null,
    create = null,
    pageSize = Infinity,
    searchDelay = 300,
    filter = null,
}) {
    if (!(trigger instanceof HTMLElement) || !Array.isArray(items) || !Array.isArray(footer) || typeof onSelect !== 'function') {
        throw new TypeError('openPicker requires a trigger, items, footer actions, and an onSelect callback');
    }
    if (activePicker?.trigger === trigger) {
        closePicker({ restoreFocus: true });
        return { close: () => {}, refresh: () => {}, get isOpen() { return false; } };
    }
    closePicker({ animate: false, restoreFocus: false });

    // A picker opened from inside a menu popover or sheet (a select row in a form popover) is a popover over it on any width,
    // so the menu surface stays open under the pick, as a dialog does under a nested picker.
    const parentLayer = trigger.closest('.sb-action-popover, .sb-action-sheet');
    const state = createPickerState({
        trigger,
        owner: owner instanceof HTMLElement ? owner : trigger,
        title,
        items,
        selected,
        multiple,
        getItemState,
        onSelect,
        footer,
        selectionCount,
        searchLabel,
        searchPlaceholder,
        emptyText,
        bounds,
        matchTriggerWidth,
        onClose,
        create,
        pageSize,
        searchDelay,
        filter,
        kind: renderAsPopover || parentLayer || !isMobileLayout() ? 'popover' : 'sheet',
    });
    setTriggerExpanded(trigger, true);

    // The handlers close over their own picker, so the one that is open cannot receive an event that belongs to another.
    const onKeydown = event => handlePickerKeydown(state, event);
    const onInput = () => handlePickerInput(state);
    const onFocusOut = event => handlePopoverFocusOut(state, event);
    if (state.kind === 'sheet') {
        const frame = createSheetFrame();
        frame.title.textContent = title;
        frame.element.setAttribute('aria-labelledby', frame.title.id || (frame.title.id = createId('sb-picker-title')));
        buildPickerContent(state, frame.body);
        hostOverlayLayer(frame.backdrop, frame.element);
        frame.element.addEventListener('keydown', onKeydown, true);
        state.input.addEventListener('input', onInput);
        state.surface = frame.element;
        state.removeContentListeners = () => {
            frame.element.removeEventListener('keydown', onKeydown, true);
            state.input.removeEventListener('input', onInput);
        };
        activePicker = state;
        renderOptions(state);
        frame.controller.open();
    } else {
        const popover = document.createElement('div');
        popover.className = 'sb-action-popover sb-picker';
        if (multiple) popover.classList.add('sb-picker--multiple');
        popover.tabIndex = -1;
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', title);
        popover.style.width = 'min(320px, calc(100vw - 16px))';
        buildPickerContent(state, popover);
        popover.addEventListener('keydown', onKeydown);
        popover.addEventListener('focusout', onFocusOut);
        state.input.addEventListener('input', onInput);
        blockUpstreamDrawerClose(popover);
        hostOverlayLayer(popover);
        state.surface = popover;
        state.removeContentListeners = () => {
            popover.removeEventListener('keydown', onKeydown);
            popover.removeEventListener('focusout', onFocusOut);
            state.input.removeEventListener('input', onInput);
        };
        activePicker = state;
        renderOptions(state);
        handleResize();
        state.positionKey = positionKeyOf(state);
        animateIn(popover, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], {
            duration: MOTION_FAST,
            easing: MOTION_EASE_OUT_CUBIC,
            styles: { 'transform-origin': state.origin },
        });
        window.addEventListener('resize', handleResize, { passive: true });
        document.addEventListener('pointerdown', handleOutsidePointerDown, true);
        requestAnimationFrame(() => {
            if (activePicker === state) {
                state.input.focus({ preventScroll: true });
            }
        });
    }
    state.surface.id ||= createId('sb-picker-dialog');
    trigger.setAttribute('aria-controls', state.surface.id);
    if (parentLayer) {
        state.removeParentListener = linkChildLayer(state.surface, trigger, () => {
            if (activePicker === state) closePicker({ animate: false, restoreFocus: false });
        });
    }
    return {
        close: () => {
            if (activePicker === state) {
                closePicker({ restoreFocus: true });
            }
        },
        refresh: (items = state.items) => {
            if (activePicker !== state) return;
            if (!Array.isArray(items)) throw new TypeError('Picker items must be an array.');
            setItems(state, items);
            renderOptions(state);
            scheduleReposition(state);
        },
        get isOpen() { return activePicker === state; },
    };
}

/** Keyboard focus leaving the desktop popover dismisses it without pulling focus back. */
function handlePopoverFocusOut(state, event) {
    if (activePicker !== state || state.kind === 'sheet') return;
    const next = event.relatedTarget;
    if (next instanceof Node && (state.surface.contains(next) || state.trigger.contains(next))) return;
    if (!(next instanceof Node)) return;
    closePicker({ restoreFocus: false });
}

export function closePicker({ animate = true, restoreFocus = true } = {}) {
    const state = activePicker;
    if (!state) {
        return;
    }
    state.restoreFocus = restoreFocus;
    if (state.kind === 'sheet') {
        mobileFrame?.controller.close({ animate, restoreFocus });
        return;
    }
    finishClose();
    stopMotion(state.surface);
    const surface = state.surface;
    const motion = animateOut(surface, [{ opacity: 1 }, { opacity: 0 }], () => {
        surface.hidden = true;
    }, {
        enabled: animate,
        duration: MOTION_POPOVER_CLOSE,
        onEnd: () => surface.remove(),
    });
    if (!motion) {
        surface.remove();
    }
}

export function isPickerOpen(trigger = null) {
    return Boolean(activePicker) && (!trigger || activePicker.trigger === trigger);
}
