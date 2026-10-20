import { createListEditor, loadListEditorStyles } from '../../../sillybunny-editor/list-shell.js';
import { createEntityRow } from '../../../sillybunny-editor/entity-row.js';
import { reconcileRows, rowEntry, bindListKeyboard, bindSortable } from '../../../sillybunny-editor/list-rows.js';
import { createListHeader } from '../../../sillybunny-editor/list-header.js';
import { createListSearch } from '../../../sillybunny-editor/list-search.js';
import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { createBanner } from '../../../sillybunny-editor/banner.js';
import { createSelectionMode } from '../../../sillybunny-editor/selection-mode.js';
import { registerEditorNavigation, confirmEditorLeave } from '../../../sillybunny-editor/navigation.js';
import { objectNavigation } from '../../../sillybunny-editor/object-navigation.js';
import { closePicker, isPickerOpen, openPicker } from '../../../sillybunny-editor/picker.js';
import { confirmDestructiveAction } from '../../../sillybunny-delete-confirm.js';
import { openActionMenu, closeActionMenu, isActionMenuOpen } from '../../../sillybunny-action-menu.js';
import { getTokenCountAsync, getTokenizerModel } from '../../../tokenizers.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { t, translate } from '../../../i18n.js';
import { buildAgentListModel, buildAgentTemplatePickerModel, getAgentRowMenuItems, moveAgentWithinSubheading, getAgentSelectionKeys, getAgentSelectionKey } from './agent-list-model.js';
import { mountAgentSettings } from './settings-page.js';
import { mountCompanionsPage } from './companions-page.js';
import { mountAgentGroups } from './groups-page.js';
import { mountAgentDetail } from './agent-editor.js';

let adapter = null;
const mounts = new WeakMap();
const controllers = new Set();
let pendingDraft = null;

const activePanel = () => [...controllers].find(controller => controller.isVisible()) ?? [...controllers][0];

async function revealAgentsTab() {
    await globalThis.SillyBunnyShell.openTab('left', 'agents');
    // The shell API opens the mobile category list; activating its tab reveals the content pane.
    document.querySelector('[data-sb-settings-tab="agents"]')?.click();
}

objectNavigation.register(
    'agent-editor',
    {
        exists: key => key === 'new-agent' || adapter?.getEntries().some(entry => entry.key === key),
        async open(target, { isCurrent }) {
            await revealAgentsTab();
            if (!isCurrent()) return false;
            return Boolean(await activePanel()?.openAgent(target.id, { isCurrent }));
        },
        captureState: () => activePanel()?.captureState(),
        current: () => ({
            kind: 'agent-editor',
            id: activePanel()?.currentKey(),
        }),
    },
);
objectNavigation.register(
    'agent-list',
    {
        async open(_target, {
            restore,
            isCurrent,
        }) {
            await revealAgentsTab();
            if (!isCurrent()) return false;
            const panel = activePanel();
            if (!panel) return false;
            await panel.closeDetail();
            panel.restoreState(restore);
            return isCurrent();
        },
        captureState: () => activePanel()?.captureState(),
    },
);

export async function openAgentDetail({
    entry = null,
    draft = null,
    autoOpenCompanionMaker = false,
    origin = 'agent-list',
} = {}) {
    pendingDraft = draft ? {
        agent: structuredClone(draft),
        maker: autoOpenCompanionMaker,
    } : null;
    return objectNavigation.navigate({
        kind: 'agent-editor',
        id: entry?.key ?? 'new-agent',
    }, { from: { kind: origin } });
}

export const closeAgentDetail = () => activePanel()?.closeDetail();

export const openCompanionsOverview = () => objectNavigation.navigate({ kind: 'companion-dashboard' }, { from: { kind: 'agent-list' } });

objectNavigation.register('companion-dashboard', {
    async open(_target, { restore, isCurrent }) {
        await revealAgentsTab();
        if (!isCurrent()) return false;
        const panel = activePanel();
        if (!panel || !await panel.openPage('companions')) return false;
        panel.restorePageState(restore);
        return isCurrent();
    },
    captureState: () => activePanel()?.capturePageState(),
});

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
        case 'preview-prompt': return t`Preview Prompt in Context`;
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

const ROW_MENU_GLYPHS = {
    pin: 'thumbtack', unpin: 'thumbtack', 'move-up': 'arrow-up', 'move-down': 'arrow-down',
    'preview-prompt': 'file-lines', 'preview-feedback': 'file-lines', 'run-last': 'play',
    'apply-last': 'paper-plane', 'apply-target': 'bullseye',
    'convert-companion': 'right-left', 'convert-inline': 'right-left', duplicate: 'clone', update: 'arrows-rotate',
    export: 'file-export', 'restore-default': 'rotate-left', delete: 'trash',
};

export function mountAgentsPanel(column) {
    if (mounts.has(column)) return mounts.get(column);
    let shell;
    let model;
    let pageController;
    let returnFocusKey = null;
    let selection;
    let bulkBusy = false;
    let destroyed = false;
    let frame = 0;
    let resolveReady;
    const ready = new Promise(resolve => {
        resolveReady = resolve;
    });
    const groups = new Map();
    const entities = new WeakMap();
    const busyKeys = new Set();
    const counts = new Map();
    const requests = new Set();
    let tokenizer = '';
    let activeTokenKeys = new Set();
    const filters = { categories: [], onlyOn: accountStorage.getItem('ica--agent-list-only-on') === 'true' };
    const list = element('div', 'ica-agents-list');
    const body = element('div', 'ica-agents-body');
    const searchField = element('div', 'ica-agents-search');
    searchField.hidden = true;
    const searchEntry = element('label', 'ica-agents-search-field');
    const searchIcon = element('i', 'fa-solid fa-magnifying-glass');
    searchIcon.setAttribute('aria-hidden', 'true');
    const input = element('input', 'ica-agents-search-input');
    input.type = 'search';
    input.placeholder = t`Search Agents…`;
    input.setAttribute('aria-label', t`Search Agents`);
    const run = operation => Promise.resolve().then(operation).catch(error => globalThis.toastr?.error(error.message));
    const refreshSoon = () => {
        if (frame || destroyed) return;
        frame = requestAnimationFrame(() => {
            frame = 0; refresh();
        });
    };
    // Agents owns three popup implementations; dismiss competitors before opening, not on later focusout.
    const preparePopup = trigger => {
        closePicker({ animate: false, restoreFocus: false });
        pageController?.closePopover?.(trigger);
        if (!isActionMenuOpen(trigger)) closeActionMenu({ animate: false, restoreFocus: false });
    };
    const showMenu = (trigger, sections, title) => {
        if (isPickerOpen(trigger)) {
            closePicker({ animate: false, restoreFocus: true });
            return;
        }
        preparePopup(trigger);
        openActionMenu({ trigger, sections, title });
    };
    const header = createListHeader({
        title: t`Agents`, actions: [
            { id: 'stop', label: t`Stop`, icon: 'stop', onActivate: () => run(() => adapter.stop()) },
            { id: 'search', label: t`Search Agents`, icon: 'magnifying-glass', toggle: true, onActivate: () => search.toggle() },
            {
                id: 'add', label: t`Add Agent`, icon: 'plus', menu: true, onActivate: trigger => showMenu(trigger, [{
                    items: [
                        { label: t`New Agent`, icon: 'fa-solid fa-plus', onSelect: () => run(() => adapter.openEditor()) },
                        { label: t`New Companion`, icon: 'fa-solid fa-user-plus', onSelect: () => run(() => adapter.newCompanion(false)) },
                        { label: t`New Agent from Template…`, icon: 'fa-solid fa-folder-open', onSelect: () => openTemplates(false) },
                        { label: t`New Companion from Template…`, icon: 'fa-solid fa-folder-open', onSelect: () => openTemplates(true) },
                        { label: t`AI Maker…`, icon: 'fa-solid fa-wand-magic-sparkles', onSelect: () => run(() => adapter.newCompanion(true)) },
                        { label: t`Import…`, icon: 'fa-solid fa-file-import', onSelect: () => adapter.importFile.click() },
                    ],
                }], t`Add Agent`),
            },
            {
                id: 'more', label: t`Agents Menu`, icon: 'ellipsis-vertical', menu: true, onActivate: trigger => {
                    const state = adapter.state();
                    const count = state.updates;
                    showMenu(trigger, [{
                        items: [
                            { label: t`Settings`, icon: 'fa-solid fa-gear', onSelect: () => run(() => openPage('settings')) },
                            { label: t`Companions Overview`, icon: 'fa-solid fa-comments', onSelect: () => run(openCompanionsOverview) },
                            { label: t`Agent Groups`, icon: 'fa-solid fa-layer-group', onSelect: () => run(() => openPage('groups')) },
                        ],
                    }, {
                        items: [
                            { label: t`Select`, icon: 'fa-solid fa-list-check', onSelect: () => selection.enter(null, trigger) },
                            ...(count ? [{ label: t`Update All (${count})…`, icon: 'fa-solid fa-arrows-rotate', onSelect: () => run(adapter.updateAll) }] : []),
                            { label: t`Fix Trackers`, icon: 'fa-solid fa-screwdriver-wrench', disabled: state.running || state.fixRunning, onSelect: () => run(adapter.fixTrackers) },
                            { label: t`Convert Trackers to Companions…`, icon: 'fa-solid fa-right-left', onSelect: () => run(adapter.convertTrackers) },
                            { label: t`Export All…`, icon: 'fa-solid fa-file-export', onSelect: adapter.exportAll },
                        ],
                    }], t`Agents Menu`);
                },
            },
        ],
    });
    const globalSwitch = switchControl(t`Agents On`, false, checked => run(async () => {
        await adapter.setGlobalEnabled(checked); refresh();
    }));
    header.element.insertBefore(switchTarget(globalSwitch), header.button('stop'));
    const banner = createBanner({
        title: t`lorum ipsum`, actionLabel: t`Turn On`, onActivate: () => run(async () => {
            await adapter.setGlobalEnabled(true); refresh();
        }),
    });
    banner.element.firstElementChild.dataset.sbCopyPlaceholder = 'true';
    function filterSections() {
        return [{
            items: [
                {
                    label: t`Only agents that are on`, kind: 'check', checked: filters.onlyOn, onSelect: () => {
                        filters.onlyOn = !filters.onlyOn;
                        accountStorage.setItem('ica--agent-list-only-on', String(filters.onlyOn));
                        refresh();
                    },
                },
            ],
        }, {
            items: Object.entries(adapter.categories).map(([key, value]) => ({
                label: translate(value.label), kind: 'check', checked: filters.categories.includes(key), onSelect: () => {
                    filters.categories = filters.categories.includes(key) ? filters.categories.filter(category => category !== key) : [...filters.categories, key];
                    refresh();
                },
            })),
        }];
    }
    const filterButton = element('button', 'sb-list-header__button ica-agents-filter');
    filterButton.type = 'button';
    filterButton.title = t`Filter Agents`;
    filterButton.setAttribute('aria-label', t`Filter Agents`);
    filterButton.setAttribute('aria-haspopup', 'menu');
    filterButton.setAttribute('aria-expanded', 'false');
    filterButton.setAttribute('aria-pressed', 'false');
    const filterIcon = element('i', 'fa-solid fa-filter');
    filterIcon.setAttribute('aria-hidden', 'true');
    filterButton.append(filterIcon);
    filterButton.addEventListener('click', () => showMenu(filterButton, filterSections(), t`Filter Agents`));
    searchEntry.append(searchIcon, input);
    searchField.append(searchEntry, filterButton);
    const search = createListSearch({ field: searchField, input, trigger: header.button('search'), scope: list, scroller: body, heightProperty: '--ica-agents-search-height', onChange: refreshSoon });
    let searchPointerActive = false;
    let pendingSearchBlur = null;
    let searchBlurFrame = 0;
    const finishSearchPointer = () => {
        searchPointerActive = false;
        cancelAnimationFrame(searchBlurFrame);
        searchBlurFrame = 0;
        const close = pendingSearchBlur;
        pendingSearchBlur = null;
        close?.(true);
    };
    const startSearchPointer = event => {
        searchPointerActive = document.activeElement === input && !searchField.contains(event.target);
    };
    const releaseSearchPointer = () => {
        searchPointerActive = false;
        if (pendingSearchBlur) searchBlurFrame = requestAnimationFrame(finishSearchPointer);
    };
    const closeEmptySearchOnBlur = event => {
        if (input.value || searchField.contains(event.relatedTarget) || event.relatedTarget === header.button('search')) return;
        const nextFocus = event.relatedTarget;
        const close = (restoreImmediately = false) => {
            if (destroyed || input.value || searchField.hidden) return;
            search.close();
            if (!(nextFocus instanceof HTMLElement) || !nextFocus.isConnected) return;
            if (restoreImmediately) nextFocus.focus({ preventScroll: true });
            else queueMicrotask(() => nextFocus.focus({ preventScroll: true }));
        };
        // Keep pointer-down coordinates stable until the browser has resolved the click target.
        if (searchPointerActive) pendingSearchBlur = close;
        else close();
    };
    input.addEventListener('blur', closeEmptySearchOnBlur);
    document.addEventListener('pointerdown', startSearchPointer, true);
    document.addEventListener('click', finishSearchPointer, true);
    document.addEventListener('pointerup', releaseSearchPointer, true);
    document.addEventListener('pointercancel', finishSearchPointer, true);

    function openTemplates(companionTemplates) {
        preparePopup(null);
        closeActionMenu({ animate: false, restoreFocus: false });
        const categories = Object.fromEntries(Object.entries(adapter.categories).map(([key, value]) => [key, { ...value, label: translate(value.label) }]));
        const subcategories = Object.fromEntries(Object.entries(adapter.subcategories).map(([key, value]) => [key, { ...value, label: translate(value.label) }]));
        const items = buildAgentTemplatePickerModel({ entries: adapter.getEntries(), categories, subcategories, companionTemplates });
        openPicker({
            trigger: header.button('add'),
            title: companionTemplates ? t`New Companion from Template` : t`New Agent from Template`,
            searchLabel: t`Search Templates`,
            items: items.map(item => ({
                value: item.id, label: item.label, group: item.group,
                subtitle: item.added ? (item.description ? t`Added · ${item.description}` : t`Added`) : item.description,
            })),
            onSelect: id => run(() => adapter.openEditor(items.find(item => item.id === id).entry)),
            onClose: () => header.button('add').setAttribute('aria-haspopup', 'menu'),
        });
    }
    const selectionHeader = element('div', 'ica-agents-selection-header');
    const actionBar = element('div', 'ica-agents-selection-actions');

    function updateSelectionActions() {
        if (!selection?.isActive) return;
        header.element.hidden = true;
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
            more.addEventListener('click', () => showMenu(more, [{
                items: [
                    { label: t`Run on Companion Outputs`, icon: 'fa-solid fa-share-nodes', onSelect: () => run(() => bulkAction('companion-outputs')) },
                    { label: t`Role: System`, icon: 'fa-solid fa-gear', onSelect: () => run(() => bulkAction('role-system')) },
                    { label: t`Role: User`, icon: 'fa-solid fa-user', onSelect: () => run(() => bulkAction('role-user')) },
                    { label: t`Convert to Companion`, icon: 'fa-solid fa-right-left', onSelect: () => run(() => bulkAction('convert-companion')) },
                    { label: t`Save as Group…`, icon: 'fa-solid fa-layer-group', onSelect: () => run(() => bulkAction('group')) },
                ],
            }], t`Selection Menu`));
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
        try {
            if (action === 'group') await adapter.createGroup(keys);
            else if (action === 'properties') await adapter.editProperties(keys);
            else await adapter.bulk(keys, action);
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
            await operation(entry);
            refresh();
            if (!pageController?.root?.contains(document.activeElement)) focusRow(key, focusedSwitch ? 'input[role="switch"]' : '');
        } finally {
            busyKeys.delete(entry.key); refresh();
        }
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
        const sections = ['organise', 'run', 'manage', 'destructive'].map(section => ({
            items:
            getAgentRowMenuItems(current.entry, { model, rowKey: current.key }).filter(item => item.section === section).map(item => ({
                label: menuLabel(item), icon: `fa-solid fa-${ROW_MENU_GLYPHS[item.id]}`, danger: item.danger, onSelect: () => run(async () => {
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
        const entity = createEntityRow({
            key: value.key, label: value.entry.agent.name, avatar: glyph,
            grip: true, suffix: [switchTarget(control), more], activation: 'activate',
            compatClasses: { row: ['ica-agent-row'] },
        });
        entities.set(entity.row, { entity, control });
        if (value.pinnedCopy) {
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
            const remember = count => {
                if (activeTokenKeys.has(key)) counts.set(key, count);
            };
            getTokenCountAsync(prompt, 0).then(remember, () => remember('—')).finally(() => {
                requests.delete(key);
                if (activeTokenKeys.has(key)) refreshSoon();
            });
        }
        return '—';
    }

    function refresh() {
        if (!shell || !adapter || destroyed) return;
        if (shell.isNavigating || shell.pointerActive) {
            shell.deferRefresh(); return;
        }
        const state = adapter.state();
        if (['settings', 'companions', 'groups'].includes(shell.selectedKey)) pageController?.refresh?.();
        const entries = adapter.getEntries();
        const categories = Object.fromEntries(Object.entries(adapter.categories).map(([key, value]) => [key, { ...value, label: translate(value.label) }]));
        model = buildAgentListModel({ entries, categories, enabledKeys: state.enabledKeys, search: input.value, filters });
        const filtersActive = filters.onlyOn || filters.categories.length > 0;
        filterButton.setAttribute('aria-pressed', String(filtersActive));
        header.setPressed('search', filtersActive);
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
                    const stage = element('h3', 'ds-pref-group-heading ica-agents-stage', titles[section.key]);
                    const heading = element('h4', 'ica-agents-category', group.label);
                    const box = element('div', 'ica-agents-box');
                    box.setAttribute('role', 'list');
                    root.append(stage, heading, box);
                    cached = { root, stage, box, rows: new Map(), sortable: null };
                    groups.set(key, cached);
                }
                cached.stage.hidden = group !== section.groups[0];
                if (cached.root === cursor) cursor = cursor.nextElementSibling;
                else if (cached.root.nextElementSibling !== cursor || cached.root.parentElement !== body) body.insertBefore(cached.root, cursor);
                reconcileRows({
                    container: cached.box, cache: cached.rows, entries: group.rows, key: row => row.key, signature: row => row.key, create: makeRow,
                    update: (row, value) => {
                        const { entity, control } = entities.get(row);
                        const agent = value.entry.agent;
                        const badges = [];
                        if (value.entry.template && Number(value.entry.template.version) > Number(agent.version)) badges.push(element('span', 'ica-agent-update', t`Update available`));
                        const tokens = tokenCount(agent.prompt || '');
                        const description = agent.description || String(agent.prompt || '').slice(0, 80).replace(/\n/g, ' ') + (agent.prompt?.length > 80 ? '…' : '');
                        badges.push(element('span', 'ica-agent-token', String(tokens)));
                        entity.update({
                            label: agent.name, subtitle: description, badges,
                            attributes: { 'data-saved': 'true', 'data-agent-id': agent.id, 'aria-description': t`${description} · ${tokens} tokens` },
                        });
                        row.classList.toggle('is-selected', shell.isOpen && value.selectionKey === pageController?.getState?.().key);
                        control.checked = value.enabled;
                        control.disabled = busyKeys.has(value.selectionKey);
                        control.setAttribute('aria-label', t`Turn On ${agent.name}`);
                        control.title = t`Turn On ${agent.name}`;
                        if (row.querySelector('.ica-agent-grip')) entity.slots.grip.setAttribute('aria-disabled', String(model.filtered || selection?.isActive));
                    },
                });
                if (section.key !== 'pinned') cached.sortable = bindSortable(cached.box, {
                    handle: '.ica-agent-grip', items: '> .ica-agent-row[data-saved="true"]', disabled: model.filtered || selection?.isActive,
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
        const emptyState = model.savedCount ? 'no-results' : 'no-agents';
        if (empty && empty.dataset.emptyState !== emptyState) {
            empty.remove(); empty = null;
        }
        if (model.visibleKeys.length) empty?.remove();
        else if (!empty) {
            empty = createStatusPage({
                icon: model.savedCount ? 'magnifying-glass' : 'puzzle-piece',
                title: model.savedCount ? t`No Results` : t`No Agents`, description: t`lorum ipsum`, compact: true,
                actions: model.savedCount ? [] : [
                    { label: t`New Agent`, onActivate: () => run(() => adapter.openEditor()) },
                    { label: t`New Agent from Template…`, onActivate: () => openTemplates(false) },
                ],
            }).element;
            empty.dataset.emptyState = emptyState;
            empty.querySelector('.sb-status-page__description').dataset.sbCopyPlaceholder = 'true';
            body.append(empty);
        }
        search.report(model.visibleKeys.length, model.savedCount);
        selection?.decorate();
        updateSelectionActions();
    }

    async function openPage(key) {
        await ready;
        if (!await confirmEditorLeave({ session: detailSession })) return false;
        return shell.selectItem(key, { guard: false });
    }

    shell = createListEditor({
        container: column, storageKey: 'sb-agents-list-width', rootTag: 'section', label: t`Agents`, escapeCloses: false,
        classNames: { root: 'ica-agents-editor' }, dragHandleSelector: '.ica-agent-grip[aria-disabled="false"]',
        renderList: refresh,
        focusTarget: detail => detail.querySelector('.ica-agent-detail .sb-persona-entry-name')
            ?? detail.querySelector('[autofocus], input, button'),
        // The router keeps its origin token; the mounted session owns the canonical saved identity.
        getKey: key => shell?.isOpen && key === pageController?.getState?.().key ? shell.selectedKey : key,
        isDirty: () => pageController?.isDirty?.() ?? false,
        onSave: () => pageController?.save?.() ?? true, onDiscard: () => pageController?.discard?.(),
        onDeselect: () => {
            pageController?.destroy(); pageController = null;
        },
        renderDetail: (host, key) => {
            pageController?.destroy();
            returnFocusKey = key;
            const onClose = () => run(backToOrigin);
            if (key === 'settings') pageController = mountAgentSettings({ host, services: adapter.settings, onClose, preparePopup });
            else if (key === 'groups') pageController = mountAgentGroups({ host, services: adapter.groups, onClose, preparePopup });
            else if (key === 'companions') pageController = mountCompanionsPage({ host, services: adapter.companions, onClose, preparePopup });
            else if (key === 'new-agent' || key.startsWith('agent:') || key.startsWith('agent-template:')) {
                const entry = adapter.getEntries().find(entry => entry.key === key);
                const creation = key === 'new-agent' ? pendingDraft : null;
                pendingDraft = null;
                pageController = mountAgentDetail({
                    host,
                    entry,
                    draft: creation?.agent,
                    adapter,
                    preparePopup,
                    requestClose: backToOrigin,
                    onSaved: saved => {
                        // Keep the mounted session and routing origin while the saved identity changes.
                        returnFocusKey = `agent:${saved.id}`;
                        refresh();
                    },
                });
                if (creation?.maker) queueMicrotask(() => pageController?.maker?.());
            } else {
                const status = createStatusPage({ icon: 'user-group', title: t`Companions Unavailable`, description: t`lorum ipsum`, actions: [{ label: t`Back`, onActivate: onClose }] });
                status.element.querySelector('.sb-status-page__description').dataset.sbCopyPlaceholder = 'true';
                host.replaceChildren(status.element);
                pageController = { destroy: () => status.element.remove() };
            }
        },
        findRow: key => {
            const current = returnFocusKey ?? key;
            return ['settings', 'companions', 'groups'].includes(current) || current.startsWith('agent-template:') || current === 'new-agent'
                ? header.button(current.startsWith('agent-template:') || current === 'new-agent' ? 'add' : 'more')
                : [...shell.sidebar.querySelectorAll('[data-sb-list-key]')].find(row => row.dataset.sbListKey === current);
        },
    });
    selection = createSelectionMode({
        root: shell.root, list: body, rowSelector: '.ica-agent-row', keySourceSelector: '.ica-agent-grip',
        getKey: row => getAgentSelectionKey(row.dataset.sbListKey), getAllKeys: () => getAgentSelectionKeys(model),
        header: selectionHeader, actionBar, title: count => t`${count} selected`, selectAllLabel: t`Select All`,
        canEnter: () => !bulkBusy && !shell.isOpen,
        actions: [
            { id: 'on', label: t`Turn On`, icon: 'fa-solid fa-toggle-on', onActivate: () => run(() => bulkAction('on')) },
            { id: 'off', label: t`Turn Off`, icon: 'fa-solid fa-toggle-off', onActivate: () => run(() => bulkAction('off')) },
            { id: 'properties', label: t`Edit Properties…`, icon: 'fa-solid fa-sliders', onActivate: () => run(() => bulkAction('properties')) },
            { id: 'delete', label: t`Delete…`, icon: 'fa-solid fa-trash', danger: true, onActivate: () => run(() => bulkAction('delete')) },
        ],
        onChange: () => {
            updateSelectionActions(); refreshSoon();
        },
        onExit: () => {
            header.element.hidden = false; refreshSoon();
        },
    });
    const unbindRows = bindListKeyboard(body, {
        rowSelector: '.ica-agent-row', keySourceSelector: '.ica-agent-grip',
        onOpen: row => run(() => mutate(row, entry => adapter.openEditor(entry))), onMove: (row, direction) => run(() => move(rowEntry(row).key, { direction })),
    });
    const detailSession = {
        isOpen: () => shell.isOpen,
        isDirty: () => pageController?.isDirty?.() ?? false,
        save: () => pageController?.save?.() ?? true,
        discard: () => pageController?.discard?.(),
        flushDraft: () => pageController?.flushDraft?.(),
    };
    const backToOrigin = () => objectNavigation.back({
        current: {
            kind: shell.selectedKey === 'companions' ? 'companion-dashboard' : 'agent-editor',
            ...(shell.selectedKey === 'companions' ? {} : { id: shell.selectedKey }),
        },
        fallback: () => shell.deselectItem(),
    });
    const unregisterNavigation = registerEditorNavigation({
        session: detailSession,
        isActive: () => !destroyed && !shell.root.hidden && !shell.root.closest('[hidden], [aria-hidden="true"], [inert]'),
        close: () => run(backToOrigin), escape: false,
        guardSelector: '[data-sb-settings-tab]:not([data-sb-settings-tab="agents"]), #sb-settings-close, [data-sb-drawer-close]',
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
        } else run(backToOrigin);
    });
    list.append(header.element, selectionHeader, searchField, banner.element, body, actionBar);
    shell.sidebar.append(list);
    shell.root.hidden = true;
    const controller = {
        ready, refresh, openPage,
        capturePageState: () => pageController?.captureState?.(),
        restorePageState: state => pageController?.restoreState?.(state),
        focusControl: id => pageController?.focusControl?.(id),
        isVisible: () => !destroyed && !shell.root.closest('[hidden], [aria-hidden="true"], [inert]'),
        currentKey: () => shell.selectedKey,
        captureState: () => ({
            query: input.value,
            filters: structuredClone(filters),
            scrollTop: body.scrollTop,
            focusKey: pageController?.getState?.().key ?? document.activeElement?.closest('[data-sb-list-key]')?.dataset.sbListKey,
        }),
        restoreState(state) {
            if (!state) return;
            search.setQuery(state.query ?? '', { notify: false });
            if (input.value) search.open();
            Object.assign(filters, state.filters);
            refresh();
            body.scrollTop = state.scrollTop ?? 0;
            const row = [...body.querySelectorAll('[data-sb-list-key]')].find(row => row.dataset.sbListKey === state.focusKey);
            if (!returnFocusKey || adapter.getEntries().some(entry => entry.key === returnFocusKey)) return;
            row?.focus({ preventScroll: true });
        },
        closeDetail: () => shell.deselectItem({ guard: false }),
        async openAgent(key, { isCurrent = () => true } = {}) {
            await ready;
            if (!isCurrent() || destroyed) return false;
            return shell.selectItem(key, { isCurrent });
        },
        async connect() {
            if (!adapter || destroyed) return;
            await loadListEditorStyles();
            for (const href of [
                'css/sillybunny-persona-detail.css',
                'css/sillybunny-prompt-editor.css',
                'scripts/extensions/in-chat-agents/ui/agent-editor.css',
            ]) {
                if (!document.querySelector(`link[href="${href}"]`)) {
                    const link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = href;
                    document.head.append(link);
                }
            }
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
            cancelAnimationFrame(searchBlurFrame);
            document.removeEventListener('pointerdown', startSearchPointer, true);
            document.removeEventListener('click', finishSearchPointer, true);
            document.removeEventListener('pointerup', releaseSearchPointer, true);
            document.removeEventListener('pointercancel', finishSearchPointer, true);
            pendingSearchBlur = null;
            if (isActionMenuOpen() && shell.root.contains(document.activeElement)) closeActionMenu({ animate: false });
            pageController?.destroy();
            groups.forEach(group => group.sortable?.destroy());
            unregisterNavigation(); unbindRows(); selection.destroy(); input.removeEventListener('blur', closeEmptySearchOnBlur); search.destroy(); header.destroy(); banner.destroy(); shell.destroy();
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
    return adapter.settings.fields.map(field => {
        const label = translate(field.label);
        const help = translate(field.caption || field.title);
        return {
            element: null, searchText: `${label} ${help} ${translate(field.title)} ${field.id}`.toLowerCase(), displayText: label,
            description: help, locationLabel: [tabState.label, t`Settings`].join(' · '),
            sectionLabel: t`Settings`, tabId: 'agents', tabLabel: tabState.label, dedupeKey: `agents:settings:${field.id}`,
            action: async () => {
                await revealAgentsTab();
                if (!await controller.openPage('settings')) return;
                controller.focusControl(field.id);
            },
        };
    });
}
