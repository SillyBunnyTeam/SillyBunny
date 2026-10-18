import { eventSource, event_types } from './events.js';
import { t } from './i18n.js';
import { world_names } from './world-info.js';
import { createPrefGroup, createRow, releaseRowIds } from './sillybunny-editor/rows.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';

const PRESENTATION_ATTRIBUTES = ['class', 'role', 'aria-checked', 'aria-labelledby', 'aria-describedby', 'disabled'];

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function requireControl(id, selector) {
    const control = document.getElementById(id);
    if (!control?.matches(selector) || !control.parentNode) {
        throw new Error(`World Info settings require #${id} (${selector}).`);
    }
    if (control.closest('.sb-wi-settings')) throw new Error('World Info settings are already mounted.');
    return control;
}

function describeControls(row, controls) {
    const caption = row.querySelector('.ds-row-label');
    caption.id = `sb-wi-settings-${controls[0].id}-label`;
    const description = row.querySelector('.ds-row-subtitle');
    if (description) description.id = `sb-wi-settings-${controls[0].id}-description`;
    for (const control of controls) {
        control.setAttribute('aria-labelledby', caption.id);
        if (!description) continue;
        const descriptions = new Set((control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
        descriptions.add(description.id);
        control.setAttribute('aria-describedby', [...descriptions].join(' '));
    }
}

function switchRow({ input, label, subtitle, field, listen, onChange }) {
    // The adopting switch factory has no disposer; persistent legacy controls need removable listeners.
    const content = createRow({ label, subtitle, field, suffix: input }).row;
    const row = element('label', 'ds-row ds-row-switch sb-wi-settings-switch');
    row.dataset.sbEditorField = field;
    row.htmlFor = input.id;
    row.append(...content.childNodes);
    input.classList.add('sb-switch');
    input.setAttribute('role', 'switch');
    describeControls(row, [input]);
    const refresh = () => {
        input.setAttribute('aria-checked', String(input.checked));
        row.classList.toggle('is-insensitive', input.disabled);
        row.setAttribute('aria-disabled', String(input.disabled));
    };
    listen(input, 'input', refresh);
    listen(input, 'change', () => {
        refresh();
        onChange?.(input.checked);
    });
    refresh();
    return { row, input, refresh };
}

/**
 * @param {object} options
 * @param {HTMLElement} options.host Empty detail pane owned by the list shell.
 * @param {() => void} options.onClose Guarded return to the list.
 * @returns {{ focusTarget: () => HTMLElement|null, destroy: () => void }}
 */
export function mountWorldInfoSettings({ host, onClose }) {
    if (!(host instanceof HTMLElement) || host.childNodes.length) throw new Error('World Info settings need an empty host.');
    if (typeof onClose !== 'function') throw new TypeError('World Info settings need an onClose callback.');

    const sliders = [
        { id: 'world_info_depth', label: t`Scan Depth` },
        { id: 'world_info_budget', label: t`Context %` },
        { id: 'world_info_budget_cap', label: t`Budget Cap`, subtitle: t`(0 = disabled)` },
        { id: 'world_info_min_activations', label: t`Min Activations`, subtitle: t`Scan chronologically until reached min entries or token budget.` },
        { id: 'world_info_min_activations_depth_max', label: t`Max Depth`, subtitle: t`(0 = unlimited, use budget)` },
        { id: 'world_info_max_recursion_steps', label: t`Max Recursion Steps`, subtitle: t`0 = unlimited, 1 = scans once and doesn't recurse, 2 = scans once and recurses once, etc` },
    ].map(descriptor => ({
        ...descriptor,
        range: requireControl(descriptor.id, 'input[type="range"]'),
        counter: requireControl(`${descriptor.id}_counter`, 'input[type="number"]'),
    }));
    const switches = [
        { id: 'world_info_include_names', label: t`Include Names`, subtitle: t`Include names with each message into the context for scanning` },
        { id: 'world_info_recursive', label: t`Recursive Scan`, subtitle: t`Entries can activate other entries by mentioning their keywords` },
        { id: 'world_info_case_sensitive', label: t`Case Sensitive`, subtitle: t`Lookup for the entry keys in the context will respect the case` },
        { id: 'world_info_match_whole_words', label: t`Match Whole Words`, subtitle: t`If the entry key consists of only one word, it would not be matched as part of other words` },
        { id: 'world_info_use_group_scoring', label: t`Use Group Scoring`, subtitle: t`Only the entries with the most number of key matches will be selected for Inclusion Group filtering` },
        { id: 'world_info_overflow_alert', label: t`Alert On Overflow`, subtitle: t`Alert if your world info is greater than the allocated budget.` },
    ].map(descriptor => ({ ...descriptor, input: requireControl(descriptor.id, 'input[type="checkbox"]') }));
    const strategy = requireControl('world_info_character_strategy', 'select');
    const activeSelect = requireControl('world_info', 'select[multiple]');
    const controls = [...sliders.flatMap(({ range, counter }) => [range, counter]), strategy, ...switches.map(({ input }) => input)];
    // Capture all next siblings before moving either half of a slider; restore in reverse order.
    const origins = controls.map(control => ({
        control,
        parent: control.parentNode,
        next: control.nextSibling,
        attributes: PRESENTATION_ATTRIBUTES.map(name => [name, control.getAttribute(name)]),
        disabled: control.disabled,
    }));
    const originalDisabled = new Map(origins.map(({ control, disabled }) => [control, disabled]));
    const listeners = [];
    let destroyed = false;
    let searchTimer = 0;
    const listen = (target, type, handler, disposers = listeners) => {
        target.addEventListener(type, handler);
        disposers.push(() => target.removeEventListener(type, handler));
    };

    const root = element('section', 'sb-wi-settings');
    const header = element('header', 'sb-wi-detail-header sb-wi-settings-header');
    const back = element('button', 'menu_button menu_button_icon sb-wi-detail-back');
    back.type = 'button';
    back.title = t`Back`;
    back.setAttribute('aria-label', t`Back`);
    const backIcon = element('i', 'fa-solid fa-chevron-left');
    backIcon.setAttribute('aria-hidden', 'true');
    back.append(backIcon);
    listen(back, 'click', event => {
        event.stopPropagation();
        onClose();
    });
    const title = element('h2', 'sb-wi-detail-title sb-wi-settings-title', t`Global Settings`);
    header.append(back, title);
    const body = element('div', 'sb-wi-settings-body');
    root.append(header, body);

    const books = createPrefGroup({ title: t`Active World(s) for all chats`, field: 'active-worlds' });
    books.section.classList.add('sb-wi-settings-books');
    const searchField = element('label', 'sb-wi-settings-search-field');
    const searchIcon = element('i', 'fa-solid fa-magnifying-glass');
    searchIcon.setAttribute('aria-hidden', 'true');
    const search = element('input', 'text_pole sb-wi-settings-search');
    search.type = 'search';
    search.placeholder = t`Search...`;
    search.setAttribute('aria-label', t`Search...`);
    searchField.append(searchIcon, search);
    books.group.before(searchField);
    const empty = createStatusPage({ icon: 'globe', title: t`-- World Info not found --`, compact: true });
    empty.element.classList.add('sb-wi-settings-empty');
    books.section.append(empty.element);
    const bookRows = new Map();

    function filterBooks() {
        clearTimeout(searchTimer);
        searchTimer = 0;
        const query = search.value.trim().toLocaleLowerCase();
        let shown = 0;
        for (const { row, name } of bookRows.values()) {
            row.hidden = !name.toLocaleLowerCase().includes(query);
            if (!row.hidden) shown++;
        }
        books.group.hidden = shown === 0;
        empty.element.hidden = shown > 0;
        empty.update({ title: bookRows.size ? t`No results` : t`-- World Info not found --` });
    }

    function refreshBooks() {
        const options = new Map([...activeSelect.options].map(option => [option.value, option]));
        const remaining = new Set();
        world_names.forEach((name, index) => {
            const value = String(index);
            remaining.add(value);
            let entry = bookRows.get(value);
            if (!entry) {
                const disposers = [];
                const input = element('input', '');
                input.type = 'checkbox';
                input.id = `sb-wi-settings-book-${index}`;
                entry = switchRow({
                    input,
                    label: name,
                    field: `active-world:${value}`,
                    listen: (target, type, handler) => listen(target, type, handler, disposers),
                    onChange: checked => {
                        const option = [...activeSelect.options].find(option => option.value === value);
                        if (!option || option.disabled || activeSelect.disabled) return;
                        option.selected = checked;
                        activeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    },
                });
                entry.dispose = () => disposers.splice(0).forEach(dispose => dispose());
                entry.row.classList.add('sb-wi-settings-book');
                entry.row.dataset.worldIndex = value;
                bookRows.set(value, entry);
                books.group.append(entry.row);
            }
            if (entry.name !== name) entry.row.querySelector('.ds-row-label').textContent = name;
            entry.name = name;
            entry.input.checked = Boolean(options.get(value)?.selected);
            entry.input.disabled = activeSelect.disabled || !options.has(value) || options.get(value).disabled;
            entry.refresh();
        });
        for (const [value, entry] of bookRows) {
            if (remaining.has(value)) continue;
            entry.dispose();
            entry.row.remove();
            bookRows.delete(value);
        }
        filterBooks();
    }

    const activationRows = sliders.map(descriptor => {
        const { id, label, subtitle, range, counter } = descriptor;
        const { row } = createRow({ label, subtitle, field: id, suffix: [range, counter] });
        row.classList.add('ds-row-slider', 'sb-wi-settings-slider');
        counter.classList.add('text_pole');
        describeControls(row, [range, counter]);
        descriptor.row = row;
        return row;
    });
    const strategyRow = createRow({ label: t`Insertion Strategy`, field: strategy.id, suffix: strategy }).row;
    strategy.classList.add('ds-control-flex');
    describeControls(strategyRow, [strategy]);
    const switchRows = switches.map(({ input, label, subtitle, id }) => switchRow({ input, label, subtitle, field: id, listen }));
    activationRows.push(strategyRow, ...switchRows.map(({ row }) => row));
    const activation = createPrefGroup({ title: t`Global World Info/Lorebook activation settings`, field: 'activation-settings', rows: activationRows });
    body.append(books.section, activation.section);
    host.append(root);

    const minimum = sliders.find(({ id }) => id === 'world_info_min_activations');
    const recursion = sliders.find(({ id }) => id === 'world_info_max_recursion_steps');
    function showDependency(descriptor, blocked, reason, source) {
        for (const control of [descriptor.range, descriptor.counter]) control.disabled = originalDisabled.get(control) || blocked;
        descriptor.row.classList.toggle('is-insensitive', descriptor.range.disabled);
        descriptor.row.setAttribute('aria-disabled', String(descriptor.range.disabled));
        descriptor.row.dataset.disabledBy = blocked ? source : '';
        descriptor.row.querySelector('.ds-row-subtitle').textContent = blocked ? `${reason} ${descriptor.subtitle}` : descriptor.subtitle;
    }

    function refreshDependencies() {
        const minimumActive = Number(minimum.range.value) > 0;
        const recursionActive = Number(recursion.range.value) > 0;
        // Conflicting imported settings remain recoverable without writing either setting ourselves.
        showDependency(minimum, recursionActive && !minimumActive, t`(disabled when max recursion steps are used)`, recursion.id);
        showDependency(recursion, minimumActive, `${t`Min Activations`} → ${t`Disabled`}.`, minimum.id);
    }

    function refreshSettings() {
        if (destroyed) return;
        refreshBooks();
        refreshDependencies();
        switchRows.forEach(row => row.refresh());
    }

    listen(search, 'input', () => {
        clearTimeout(searchTimer);
        if (!search.value) {
            filterBooks();
            return;
        }
        searchTimer = setTimeout(() => {
            if (!destroyed) filterBooks();
        }, 300);
    });
    listen(activeSelect, 'change', refreshSettings);
    listen(minimum.range, 'input', refreshDependencies);
    listen(recursion.range, 'input', refreshDependencies);
    listen(root, 'keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.target.matches('input, select, textarea')) event.target.blur();
        else onClose();
    });
    eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, refreshSettings);
    const observer = new MutationObserver(refreshSettings);
    observer.observe(activeSelect, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'value', 'label', 'disabled'], characterData: true });
    refreshSettings();

    return {
        focusTarget: () => destroyed ? null : search,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            clearTimeout(searchTimer);
            observer.disconnect();
            eventSource.removeListener(event_types.WORLDINFO_SETTINGS_UPDATED, refreshSettings);
            listeners.forEach(dispose => dispose());
            bookRows.forEach(entry => entry.dispose());
            for (const { control, parent, next, attributes } of [...origins].reverse()) {
                for (const [name, value] of attributes) {
                    if (value === null) control.removeAttribute(name);
                    else control.setAttribute(name, value);
                }
                parent.insertBefore(control, next?.parentNode === parent ? next : null);
            }
            bookRows.clear();
            releaseRowIds(root);
            root.remove();
        },
    };
}
