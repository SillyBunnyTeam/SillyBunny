import { createListEditor, loadListEditorStyles } from '../../../sillybunny-editor/list-shell.js';
import { createEntityRow } from '../../../sillybunny-editor/entity-row.js';
import { reconcileRows, rowEntry, bindListKeyboard, bindSortable } from '../../../sillybunny-editor/list-rows.js';
import { createListHeader } from '../../../sillybunny-editor/list-header.js';
import { createListSearch } from '../../../sillybunny-editor/list-search.js';
import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { createBanner } from '../../../sillybunny-editor/banner.js';
import { createSelectionMode } from '../../../sillybunny-editor/selection-mode.js';
import { registerEditorNavigation } from '../../../sillybunny-editor/navigation.js';
import { isPickerOpen } from '../../../sillybunny-editor/picker.js';
import { confirmDestructiveAction } from '../../../sillybunny-delete-confirm.js';
import { openActionMenu, closeActionMenu, isActionMenuOpen } from '../../../sillybunny-action-menu.js';
import { getTokenCountAsync, getTokenizerModel } from '../../../tokenizers.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { t, translate } from '../../../i18n.js';
import { buildAgentListModel, getAgentRowMenuItems, moveAgentWithinSubheading, getAgentSelectionKeys, getAgentSelectionKey, remapAgentListKeys } from './agent-list-model.js';
import { mountLegacySettings, mountLegacyGroups } from './legacy-pages.js';

let adapter = null;
const mounts = new WeakMap();
const controllers = new Set();

export function registerAgentsPanelAdapter(value) {
    adapter = value;
    for (const controller of controllers) controller.connect();
}

export function refreshAgentsPanels() {
    for (const controller of controllers) controller.refresh();
}

const element = (tag, className = '', text = '') => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
};

function switchControl(label, checked, onChange) {
    const input = element('input', 'sb-switch');
    input.type = 'checkbox';
    input.checked = checked;
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', label);
    input.title = label;
    input.addEventListener('change', () => onChange(input.checked));
    return input;
}

function switchTarget(control) {
    const target = element('label', 'ica-agent-switch-target');
    target.append(control);
    target.addEventListener('click', event => event.stopPropagation());
    return target;
}

function menuLabel(item) {
    switch (item.id) {
        case 'pin': return t`Pin to Top`;
        case 'unpin': return t`Unpin`;
        case 'move-up': return t`Move Up`;
        case 'move-down': return t`Move Down`;
        case 'preview-prompt': return t`Preview Prompt`;
        case 'preview-feedback': return t`Preview Feedback`;
        case 'run-last': return t`Run on Last Message`;
        case 'apply-last': return t`Apply to Last Reply`;
        case 'apply-target': return t`Apply to…`;
        case 'convert-companion': return t`Convert to Companion`;
        case 'convert-inline': return t`Convert to Inline`;
        case 'duplicate': return t`Duplicate`;
        case 'update': return t`Update to v${item.version}`;
        case 'export': return t`Export…`;
        case 'restore-default': return t`Restore Default…`;
        case 'delete': return t`Delete…`;
        default: throw new Error(`Unknown agent action: ${item.id}`);
    }
}

export function mountAgentsPanel(column) {
    if (mounts.has(column)) return mounts.get(column);
    let shell;
    let model;
    let pageController;
    let selection;
    let bulkBusy = false;
    let destroyed = false;
    let frame = 0;
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const groups = new Map();
    const entities = new WeakMap();
    const busyKeys = new Set();
    const counts = new Map();
    const requests = new Set();
    let tokenizer = '';
    let activeTokenKeys = new Set();
    const filters = { categories: [], onlyOn: accountStorage.getItem('ica--agent-list-only-on') === 'true' };
    const list = element('div', 'ica-agents-list');
    const fixed = element('div', 'ica-agents-fixed');
    fixed.setAttribute('role', 'list');
    const body = element('div', 'ica-agents-body');
    const searchField = element('div', 'ica-agents-search');
    const input = element('input', 'text_pole');
    input.type = 'search';
    input.placeholder = t`Search Agents…`;
    input.setAttribute('aria-label', t`Search Agents`);
    const run = operation => Promise.resolve().then(operation).catch(error => globalThis.toastr?.error(error.message));
    const refreshSoon = () => {
        if (frame || destroyed) return;
        frame = requestAnimationFrame(() => { frame = 0; refresh(); });
    };
    const showMenu = (trigger, sections, title) => openActionMenu({ trigger, sections, title });
    const header = createListHeader({ title: t`Agents`, actions: [
        { id: 'stop', label: t`Stop`, icon: 'stop', onActivate: () => run(() => adapter.stop()) },
        { id: 'add', label: t`Add Agent`, icon: 'plus', menu: true, onActivate: trigger => showMenu(trigger, [{ items: [
            { label: t`New Agent`, onSelect: () => run(() => adapter.openEditor()) },
            { label: t`New Companion`, onSelect: () => run(() => adapter.newCompanion(false)) },
            { label: t`AI Maker…`, onSelect: () => run(() => adapter.newCompanion(true)) },
            { label: t`Import…`, onSelect: () => adapter.importFile.click() },
        ] }], t`Add Agent`) },
        { id: 'more', label: t`Agents Menu`, icon: 'ellipsis-vertical', menu: true, onActivate: trigger => {
            const state = adapter.state();
            const count = state.updates;
            showMenu(trigger, [{ items: [
                { label: t`Select`, onSelect: () => selection.enter(null, trigger) },
                ...(count ? [{ label: t`Update All (${count})…`, onSelect: () => run(adapter.updateAll) }] : []),
                { label: t`Fix Trackers`, disabled: state.running || state.fixRunning, onSelect: () => run(adapter.fixTrackers) },
                { label: t`Convert Trackers to Companions…`, onSelect: () => run(adapter.convertTrackers) },
                { label: t`Export All…`, onSelect: adapter.exportAll },
            ] }], t`Agents Menu`);
        } },
    ] });
    const globalSwitch = switchControl(t`Agents On`, false, checked => run(async () => { await adapter.setGlobalEnabled(checked); refresh(); }));
    header.element.insertBefore(switchTarget(globalSwitch), header.button('stop'));
    const banner = createBanner({ title: t`lorum ipsum`, actionLabel: t`Turn On`, onActivate: () => run(async () => { await adapter.setGlobalEnabled(true); refresh(); }) });
    banner.element.firstElementChild.dataset.sbCopyPlaceholder = 'true';
    const filterButton = element('button', 'menu_button');
    filterButton.type = 'button';
    filterButton.title = t`Filter Agents`;
    filterButton.setAttribute('aria-label', t`Filter Agents`);
    filterButton.setAttribute('aria-haspopup', 'menu');
    filterButton.setAttribute('aria-expanded', 'false');
    filterButton.append(element('i', 'fa-solid fa-filter'));
    filterButton.addEventListener('click', () => showMenu(filterButton, [{ items: [
        { label: t`Only agents that are on`, kind: 'check', checked: filters.onlyOn, onSelect: () => {
            filters.onlyOn = !filters.onlyOn;
            accountStorage.setItem('ica--agent-list-only-on', String(filters.onlyOn));
            refresh();
        } },
    ] }, { items: Object.entries(adapter.categories).map(([key, value]) => ({
        label: translate(value.label), kind: 'check', checked: filters.categories.includes(key), onSelect: () => {
            filters.categories = filters.categories.includes(key) ? filters.categories.filter(category => category !== key) : [...filters.categories, key];
            refresh();
        },
    })) }], t`Filter Agents`));
    searchField.append(input, filterButton);
    const search = createListSearch({ field: searchField, input, scope: list, scroller: body, onChange: refreshSoon });
    const selectionHeader = element('div', 'ica-agents-selection-header');
    const actionBar = element('div', 'ica-agents-selection-actions');

    function updateSelectionActions() {
        if (!selection?.isActive) return;
        header.element.hidden = true;
        fixed.inert = true;
        const saved = adapter.getEntries().filter(entry => entry.kind === 'agent' && selection.selectedKeys.includes(entry.key));
        actionBar.querySelector('[data-action-id="delete"]').disabled = bulkBusy || saved.length === 0;
        for (const button of actionBar.querySelectorAll('button')) {
            if (bulkBusy) button.disabled = true;
        }
        let more = actionBar.querySelector('.ica-agents-selection-more');
        if (!more) {
            more = element('button', 'menu_button ica-agents-selection-more');
            more.type = 'button';
            more.title = t`Selection Menu`;
            more.setAttribute('aria-label', t`Selection Menu`);
            more.setAttribute('aria-haspopup', 'menu');
            more.setAttribute('aria-expanded', 'false');
            more.append(element('i', 'fa-solid fa-ellipsis-vertical'));
            more.addEventListener('click', () => showMenu(more, [{ items: [
                { label: t`Run on Companion Outputs`, onSelect: () => run(() => bulkAction('companion-outputs')) },
                { label: t`Role: System`, onSelect: () => run(() => bulkAction('role-system')) },
                { label: t`Role: User`, onSelect: () => run(() => bulkAction('role-user')) },
                { label: t`Convert to Companion`, onSelect: () => run(() => bulkAction('convert-companion')) },
                { label: t`Save as Group…`, onSelect: () => run(() => bulkAction('group')) },
            ] }], t`Selection Menu`));
            actionBar.append(more);
        }
        more.disabled = bulkBusy || selection.count === 0;
    }

    async function bulkAction(action) {
        if (bulkBusy || !selection.count) return;
        const keys = selection.selectedKeys;
        if (action === 'delete') {
            const count = adapter.getEntries().filter(entry => entry.kind === 'agent' && keys.includes(entry.key)).length;
            if (!count || !await confirmDestructiveAction({ text: t`lorum ipsum`, confirmLabel: t`Delete ${count} Saved Agents`, copyPlaceholder: true })) return;
        }
        bulkBusy = true;
        updateSelectionActions();
        const onSaved = (fromKey, agent) => {
            if (!fromKey.startsWith('agent-template:')) return;
            selection.select(remapAgentListKeys(selection.selectedKeys, { fromKey, toKey: `agent:${agent.id}` }));
        };
        try {
            if (action === 'group') await adapter.createGroup(keys);
            else if (action === 'properties') await adapter.editProperties(keys, { onSaved });
            else await adapter.bulk(keys, action, { onSaved });
        } finally {
            bulkBusy = false;
            refresh();
            selection.decorate({ prune: action === 'delete' });
            updateSelectionActions();
        }
    }

    function focusRow(key, controlSelector = '') {
        requestAnimationFrame(() => {
            const row = body.querySelector(`[data-sb-list-key="${CSS.escape(key)}"]`);
            (controlSelector ? row?.querySelector(controlSelector) : row)?.focus({ preventScroll: true });
        });
    }

    async function mutate(row, operation) {
        const { entry, key } = rowEntry(row);
        if (busyKeys.has(entry.key)) return;
        const focusedSwitch = row.contains(document.activeElement) && document.activeElement.matches('input[role="switch"]');
        busyKeys.add(entry.key);
        refresh();
        try {
            const saved = await operation(entry);
            refresh();
            focusRow(saved?.id && entry.kind === 'agent-template' ? `${key.startsWith('pinned:') ? 'pinned:' : ''}agent:${saved.id}` : key, focusedSwitch ? 'input[role="switch"]' : '');
        } finally { busyKeys.delete(entry.key); refresh(); }
    }

    async function move(key, values) {
        const result = moveAgentWithinSubheading(model, { key, ...values });
        if (!result) return;
        const focusedGrip = document.activeElement?.matches('.ica-agent-grip');
        await adapter.reorder(result.orderedKeys.map(key => key.slice(6)));
        refresh();
        focusRow(result.focusKey, focusedGrip ? '.ica-agent-grip' : '');
    }

    function openRowMenu(row, trigger) {
        const current = rowEntry(row);
        const sections = ['organise', 'run', 'manage', 'destructive'].map(section => ({ items:
            getAgentRowMenuItems(current.entry, { model, rowKey: current.key }).filter(item => item.section === section).map(item => ({
                label: menuLabel(item), danger: item.danger, onSelect: () => run(async () => {
                    if (item.id.startsWith('move-')) return move(current.key, { direction: item.id === 'move-up' ? -1 : 1 });
                    if (item.danger && !await confirmDestructiveAction({ text: t`lorum ipsum`, confirmLabel: item.id === 'delete' ? t`Delete` : t`Restore Default`, copyPlaceholder: true })) return;
                    await mutate(row, entry => adapter.perform(entry, item.id));
                }),
            })),
        }));
        showMenu(trigger, sections, t`Agent Menu`);
    }

    function makeRow(value) {
        const control = switchControl(t`Turn On Agent`, value.enabled, checked => run(() => mutate(entity.row, entry => adapter.setEnabled(entry, checked))));
        const more = element('button', 'ds-entity-row__button menu_button');
        more.type = 'button';
        more.title = t`Agent Menu`;
        more.setAttribute('aria-label', t`Agent Menu`);
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        more.append(element('i', 'fa-solid fa-ellipsis-vertical'));
        more.addEventListener('click', () => openRowMenu(entity.row, more));
        const glyph = element('i', `fa-solid ${adapter.categories[value.entry.agent.category].icon}`);
        glyph.setAttribute('aria-hidden', 'true');
        const entity = createEntityRow({ key: value.key, label: value.entry.agent.name, avatar: glyph,
            grip: true, suffix: [switchTarget(control), more], activation: 'activate',
            compatClasses: { row: ['ica-agent-row'] } });
        entities.set(entity.row, { entity, control });
        if (value.pinnedCopy || value.entry.kind !== 'agent') {
            entity.slots.grip.classList.add('ica-agent-grip-placeholder');
            entity.slots.grip.replaceChildren();
        } else {
            const grip = entity.slots.grip;
            grip.classList.add('ica-agent-grip');
            grip.removeAttribute('aria-hidden');
            grip.setAttribute('role', 'button');
            grip.tabIndex = 0;
            grip.title = t`Reorder Agent`;
            grip.setAttribute('aria-label', t`Reorder Agent`);
            grip.addEventListener('keydown', event => {
                if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                run(() => move(rowEntry(entity.row).key, { direction: event.key === 'ArrowUp' ? -1 : 1 }));
            });
        }
        return entity.row;
    }

    function tokenCount(prompt) {
        const key = `${tokenizer}:${prompt}`;
        if (counts.has(key)) return counts.get(key);
        if (!requests.has(key)) {
            requests.add(key);
            const remember = count => { if (activeTokenKeys.has(key)) counts.set(key, count); };
            getTokenCountAsync(prompt, 0).then(remember, () => remember('—')).finally(() => {
                requests.delete(key);
                if (activeTokenKeys.has(key)) refreshSoon();
            });
        }
        return '—';
    }

    function refresh() {
        if (!shell || !adapter || destroyed) return;
        if (shell.isNavigating || shell.pointerActive) { shell.deferRefresh(); return; }
        const state = adapter.state();
        const entries = adapter.getEntries();
        const categories = Object.fromEntries(Object.entries(adapter.categories).map(([key, value]) => [key, { ...value, label: translate(value.label) }]));
        const subcategories = Object.fromEntries(Object.entries(adapter.subcategories).map(([key, value]) => [key, { ...value, label: translate(value.label) }]));
        model = buildAgentListModel({ entries, categories, subcategories, enabledKeys: state.enabledKeys, search: input.value, filters });
        tokenizer = getTokenizerModel();
        activeTokenKeys = new Set(entries.map(entry => `${tokenizer}:${entry.agent.prompt || ''}`));
        for (const key of counts.keys()) {
            if (!activeTokenKeys.has(key)) counts.delete(key);
        }
        const on = model.onCount;
        const tokens = state.tokens;
        header.setSubtitle(t`${on} on · ${tokens} tokens`);
        globalSwitch.checked = state.enabled;
        header.button('stop').hidden = !state.running;
        banner.setRevealed(!state.enabled);
        const titles = { pinned: t`Pinned`, pre: t`Before Reply`, both: t`Before and After Reply`, post: t`After Reply`, companion: t`Companions` };
        const present = new Set();
        let cursor = body.firstElementChild;
        for (const section of model.sections) {
            for (const group of section.groups) {
                const key = `${section.key}:${group.key}`;
                present.add(key);
                let cached = groups.get(key);
                if (!cached) {
                    const root = element('section', 'ica-agents-group');
                    const stage = element('h3', 'ica-agents-stage', titles[section.key]);
                    const heading = element('h4', '', group.label);
                    const box = element('div', 'ica-agents-box');
                    box.setAttribute('role', 'list');
                    root.append(stage, heading, box);
                    cached = { root, stage, box, rows: new Map(), sortable: null };
                    groups.set(key, cached);
                }
                cached.stage.hidden = group !== section.groups[0];
                if (cached.root === cursor) cursor = cursor.nextElementSibling;
                else if (cached.root.nextElementSibling !== cursor || cached.root.parentElement !== body) body.insertBefore(cached.root, cursor);
                reconcileRows({ container: cached.box, cache: cached.rows, entries: group.rows, key: row => row.key, signature: row => row.key, create: makeRow,
                    update: (row, value) => {
                        const { entity, control } = entities.get(row);
                        const agent = value.entry.agent;
                        const badges = [];
                        if (value.entry.kind === 'agent' && value.entry.template && Number(value.entry.template.version) > Number(agent.version)) badges.push(element('span', 'ica-agent-update', t`Update available`));
                        const tokens = tokenCount(agent.prompt || '');
                        const description = agent.description || String(agent.prompt || '').slice(0, 80).replace(/\n/g, ' ') + (agent.prompt?.length > 80 ? '…' : '');
                        badges.push(element('span', 'ica-agent-token', String(tokens)));
                        entity.update({ label: agent.name, subtitle: description, badges,
                            attributes: { 'data-saved': String(value.entry.kind === 'agent'), 'data-agent-id': agent.id, 'aria-description': t`${description} · ${tokens} tokens` } });
                        control.checked = value.enabled;
                        control.disabled = busyKeys.has(value.selectionKey);
                        control.setAttribute('aria-label', t`Turn On ${agent.name}`);
                        control.title = t`Turn On ${agent.name}`;
                        if (row.querySelector('.ica-agent-grip')) entity.slots.grip.setAttribute('aria-disabled', String(model.filtered || selection?.isActive));
                    } });
                if (section.key !== 'pinned') cached.sortable = bindSortable(cached.box, { handle: '.ica-agent-grip', items: '> .ica-agent-row[data-saved="true"]', disabled: model.filtered || selection?.isActive,
                    touch: () => matchMedia('(pointer: coarse)').matches,
                    update: (_event, ui) => run(() => move(ui.item[0].dataset.sbListKey, { orderedKeys: [...cached.box.children].filter(row => row.dataset.saved === 'true').map(row => row.dataset.sbListKey) })),
                });
            }
        }
        for (const [key, cached] of groups) {
            if (present.has(key)) continue;
            cached.sortable?.destroy();
            cached.root.remove();
            groups.delete(key);
        }
        let empty = body.querySelector(':scope > .sb-status-page');
        if (model.visibleKeys.length) empty?.remove();
        else if (!empty) {
            empty = createStatusPage({ icon: 'magnifying-glass', title: t`No Results`, description: t`lorum ipsum`, compact: true }).element;
            empty.querySelector('.sb-status-page__description').dataset.sbCopyPlaceholder = 'true';
            body.append(empty);
        }
        search.report(model.visibleKeys.length, entries.length);
        selection?.decorate();
        updateSelectionActions();
    }

    async function openPage(key) {
        await ready;
        if (key === 'companions' && !adapter.state().conversationMode) return adapter.openCompanions();
        return shell.selectItem(key);
    }

    shell = createListEditor({ container: column, storageKey: 'sb-agents-list-width', rootTag: 'section', label: t`Agents`, escapeCloses: false,
        classNames: { root: 'ica-agents-editor' }, dragHandleSelector: '.ica-agent-grip[aria-disabled="false"]',
        renderList: refresh, getKey: key => key, isDirty: () => false, onSave: () => true, onDiscard: () => {},
        onDeselect: () => { pageController?.destroy(); pageController = null; },
        renderDetail: (host, key) => {
            pageController?.destroy();
            const onClose = () => shell.deselectItem();
            if (key === 'settings') pageController = mountLegacySettings({ host, footer: adapter.settingsFooter, onClose });
            else if (key === 'groups') pageController = mountLegacyGroups({ host, adapter, onClose, run });
            else {
                const status = createStatusPage({ icon: 'user-group', title: t`Companions Unavailable`, description: t`lorum ipsum`, actions: [{ label: t`Back`, onActivate: onClose }] });
                status.element.querySelector('.sb-status-page__description').dataset.sbCopyPlaceholder = 'true';
                host.replaceChildren(status.element);
                pageController = { destroy: () => status.element.remove() };
            }
        },
        findRow: key => fixed.querySelector(`[data-sb-list-key="${key}"]`),
    });
    selection = createSelectionMode({ root: shell.root, list: body, rowSelector: '.ica-agent-row', keySourceSelector: '.ica-agent-grip',
        getKey: row => getAgentSelectionKey(row.dataset.sbListKey), getAllKeys: () => getAgentSelectionKeys(model),
        header: selectionHeader, actionBar, title: count => t`${count} selected`, selectAllLabel: t`Select All`,
        canEnter: () => !bulkBusy && !shell.isOpen,
        actions: [
            { id: 'on', label: t`Turn On`, icon: 'fa-solid fa-toggle-on', onActivate: () => run(() => bulkAction('on')) },
            { id: 'off', label: t`Turn Off`, icon: 'fa-solid fa-toggle-off', onActivate: () => run(() => bulkAction('off')) },
            { id: 'properties', label: t`Edit Properties…`, icon: 'fa-solid fa-sliders', onActivate: () => run(() => bulkAction('properties')) },
            { id: 'delete', label: t`Delete…`, icon: 'fa-solid fa-trash', danger: true, onActivate: () => run(() => bulkAction('delete')) },
        ],
        onChange: () => { updateSelectionActions(); refreshSoon(); },
        onExit: () => { header.element.hidden = false; fixed.inert = false; refreshSoon(); },
    });
    for (const [key, label] of [['settings', t`Settings`], ['companions', t`Companions Overview`], ['groups', t`Agent Groups`]]) {
        const entity = createEntityRow({ key, label, activation: 'navigate' });
        fixed.append(entity.row);
    }
    const unbindFixed = bindListKeyboard(fixed, { onOpen: row => run(() => openPage(row.dataset.sbListKey)) });
    const unbindRows = bindListKeyboard(body, { rowSelector: '.ica-agent-row', keySourceSelector: '.ica-agent-grip',
        onOpen: row => run(() => mutate(row, entry => adapter.openEditor(entry))), onMove: (row, direction) => run(() => move(rowEntry(row).key, { direction })),
    });
    const unregisterNavigation = registerEditorNavigation({
        session: { isOpen: () => shell.isOpen, isDirty: () => false, save: () => true, discard: () => {}, flushDraft: () => {} },
        isActive: () => !destroyed && !shell.root.hidden && !shell.root.closest('[hidden], [aria-hidden="true"], [inert]'),
        close: () => run(() => shell.deselectItem()), escape: false,
    });
    shell.root.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !shell.isOpen) return;
        if (isPickerOpen() || isActionMenuOpen() || document.querySelector('dialog[open]')) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.target.matches('input, select, textarea')) {
            event.target.blur();
            shell.detail.tabIndex = -1;
            shell.detail.focus({ preventScroll: true });
        } else run(() => shell.deselectItem());
    });
    list.append(header.element, selectionHeader, searchField, banner.element, fixed, body, actionBar);
    shell.sidebar.append(list);
    shell.root.hidden = true;
    const controller = {
        ready, refresh, openPage,
        async connect() {
            if (!adapter || destroyed) return;
            await loadListEditorStyles();
            if (destroyed) return;
            shell.root.hidden = false;
            refresh();
            shell.scheduleLayout();
            resolveReady();
        },
        prepareReveal: refresh,
        onReveal: () => shell.scheduleLayout(),
        destroy() {
            destroyed = true;
            cancelAnimationFrame(frame);
            if (isActionMenuOpen() && shell.root.contains(document.activeElement)) closeActionMenu({ animate: false });
            pageController?.destroy();
            groups.forEach(group => group.sortable?.destroy());
            unregisterNavigation(); unbindFixed(); unbindRows(); selection.destroy(); search.destroy(); header.destroy(); banner.destroy(); shell.destroy();
            controllers.delete(controller);
            mounts.delete(column);
        },
    };
    controllers.add(controller);
    mounts.set(column, controller);
    if (adapter) void controller.connect();
    return controller;
}

export function getAgentsPanelSearchEntries(tabState) {
    const controller = mounts.get(tabState.searchRoot);
    if (!controller || !adapter) return [];
    return [...adapter.settingsFooter.querySelectorAll('input,select,textarea')].map(control => {
        const row = control.closest('label, .ds-row');
        const labelNode = row?.querySelector('.ds-row-label, :scope > span');
        const labelCopy = labelNode?.cloneNode(true);
        labelCopy?.querySelectorAll('small, .ds-row-subtitle').forEach(node => node.remove());
        const label = (labelCopy?.textContent || control.id).trim();
        const help = [...row?.querySelectorAll('.ds-row-subtitle, small') ?? []].map(node => node.textContent.trim()).join(' ') || control.title;
        return { element: null, searchText: `${label} ${help} ${control.title} ${control.id}`.toLowerCase(), displayText: label,
            description: help, locationLabel: [tabState.label, t`Settings`].join(' · '),
            sectionLabel: t`Settings`, tabId: 'agents', tabLabel: tabState.label, dedupeKey: `agents:settings:${control.id}`,
            action: async () => {
                await globalThis.SillyBunnyShell.openTab('left', 'agents');
                await controller.openPage('settings');
                control.scrollIntoView({ block: 'center' });
                control.focus({ preventScroll: true });
            } };
    });
}
