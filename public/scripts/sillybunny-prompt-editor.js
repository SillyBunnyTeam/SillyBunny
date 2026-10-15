import { eventSource, event_types, getRequestHeaders, main_api } from '../script.js';
import { createPromptEditorModel, PROMPT_EDITOR_UTILITY_FIELDS as UTILITY_FIELDS } from './sillybunny-prompt-editor-model.js';
import { promptManager } from './openai.js';
import { openActionMenu, closeActionMenu } from './sillybunny-action-menu.js';
import { createSheetController, blockUpstreamDrawerClose } from './sillybunny-sheet.js';
import { play, stopMotion, animateOut, prefersReducedMotion, SPRING_NAVIGATION, MOTION_FAST, MOTION_SLOW, MOTION_SURFACE, MOTION_POPOVER_CLOSE, MOTION_EASE_OUT_CUBIC } from './sillybunny-motion.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from './popup.js';
import { getTokenCountAsync, getTokenizerModel } from './tokenizers.js';
import { t, translate } from './i18n.js';
import { createSegmentedControl } from './sillybunny-segmented-control.js';

const mountedEditors = new WeakSet();
let countingEditorContent = false;
let tokenizerPrefilterInstalled = false;
const TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function icon(name) {
    const node = element('i', `fa-solid fa-${name}`);
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function button(label, glyph, action, className = '') {
    const node = element('button', `menu_button ${glyph ? 'menu_button_icon' : ''} ${className}`);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    if (glyph) {
        node.title = label;
        node.append(icon(glyph));
    } else node.textContent = label;
    node.addEventListener('click', event => {
        event.stopPropagation();
        void action(node, event);
    });
    return node;
}

function switchControl(label, checked, action, disabled = false) {
    const node = element('input', 'sb-switch');
    node.type = 'checkbox';
    node.checked = Boolean(checked);
    node.disabled = disabled;
    node.setAttribute('role', 'switch');
    node.setAttribute('aria-label', label);
    node.addEventListener('change', () => {
        void action(node.checked);
    });
    return node;
}

function capitalized(value) {
    return value ? value[0].toUpperCase() + value.slice(1) : '';
}

export function initializePromptEditor(column) {
    if (mountedEditors.has(column)) return;
    mountedEditors.add(column);
    let model = null;
    const root = element('section', 'sb-prompt-editor');
    root.setAttribute('aria-label', t`Prompts`);
    const list = element('div', 'sb-prompt-list');
    const listHeader = element('header', 'sb-prompt-list-header');
    const titles = element('div', 'sb-prompt-list-titles');
    const subtitle = element('span', 'sb-prompt-list-subtitle');
    titles.append(element('h2', '', t`Prompts`), subtitle);
    const searchField = element('label', 'sb-prompt-search-field');
    searchField.hidden = true;
    const searchIcon = icon('magnifying-glass');
    const search = element('input', 'sb-prompt-search');
    search.type = 'search';
    search.placeholder = t`Search...`;
    search.setAttribute('aria-label', t`Search prompts`);
    searchField.append(searchIcon, search);
    const listBody = element('div', 'sb-prompt-list-body');
    const editor = element('div', 'sb-prompt-detail');
    editor.hidden = true;
    const divider = element('div', 'sb-prompt-divider');
    divider.tabIndex = 0;
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', 'vertical');
    divider.setAttribute('aria-label', t`Resize prompt sidebar`);
    divider.setAttribute('aria-valuemin', '240');
    divider.setAttribute('aria-valuemax', '420');
    const status = element('div', 'sb-prompt-visually-hidden');
    status.setAttribute('aria-live', 'polite');
    root.append(list, divider, editor, status);
    list.append(listHeader, searchField, listBody);
    root.hidden = true;
    column.append(root);

    let state = null;
    let draft = null;
    let baseline = '';
    let draftScope = '';
    let kind = 'prompt';
    let mode = 'edit';
    let filter = '';
    let busy = false;
    let collapsed = false;
    let sidebarWidth = Number(localStorage.getItem('sb-pm-list-width')) || 0;
    let layoutFrame = 0;
    let synchronizeFrame = 0;
    let renderedListKey = '';
    let headerMeasuredWidth = 0;
    let headerMeasuredText = '';
    let listRefreshPending = false;
    let listPointerActive = false;
    let transition = null;
    let overlay = null;
    let propertySheet = null;
    let sheetController = null;
    let tokenTimer = null;
    let listTokenTimer = null;
    let tokenRequest = 0;
    let toastTimer = null;
    let returningId = null;
    let actions = [];
    let menuTrigger = null;
    let observedHeader = null;
    let replayingChange = false;
    let stylesReady = false;
    let tokenizerKey = '';
    const contentCounts = new Map();
    const contentRequests = new Map();
    const listGroups = new Map();
    const mobile = matchMedia('(max-width: 768px)');

    const dirty = () => Boolean(draft) && JSON.stringify(draft) !== baseline;
    const textCompletionView = () => state?.type === 'text-completions';
    const promptFor = id => state.prompts.find(prompt => prompt.identifier === id);
    const rowFor = id => listBody.querySelector(`[data-prompt-id="${CSS.escape(id)}"]`);
    const selectedId = () => draft?.identifier;
    const listWidth = () => Math.max(240, Math.min(420, sidebarWidth || root.clientWidth * 0.3));

    if (!tokenizerPrefilterInstalled) {
        // Extensions can replace jQuery without the app's CSRF prefilter; scope this repair to our reads.
        $.ajaxPrefilter((options, _original, xhr) => {
            if (countingEditorContent && options.url.startsWith('/api/tokenizers/')) xhr.setRequestHeader('X-CSRF-Token', getRequestHeaders()['X-CSRF-Token']);
        });
        tokenizerPrefilterInstalled = true;
    }

    function countContent(content) {
        if (contentCounts.has(content)) return Promise.resolve(contentCounts.get(content));
        if (contentRequests.has(content)) return contentRequests.get(content);
        const expectedTokenizer = tokenizerKey;
        let request;
        countingEditorContent = true;
        try { request = getTokenCountAsync(content, 0); } finally { countingEditorContent = false; }
        const pending = request.then(count => {
            if (tokenizerKey === expectedTokenizer) {
                contentCounts.set(content, count);
                if (contentCounts.size > 128) contentCounts.delete(contentCounts.keys().next().value);
            }
            return count;
        }).finally(() => {
            if (contentRequests.get(content) === pending) contentRequests.delete(content);
        });
        contentRequests.set(content, pending);
        return pending;
    }

    function knownCount(prompt) {
        return state.counts[prompt.identifier] ?? contentCounts.get(prompt.content) ?? '-';
    }

    function textCompletionContent(entry) {
        return Object.entries(entry.values)
            .filter(([id, value]) => id !== 'instruct_system_same_as_user' && typeof value === 'string' && value)
            .map(([, value]) => value)
            .join('\n');
    }

    function knownTextCompletionCount(entry) {
        const content = textCompletionContent(entry);
        return content ? contentCounts.get(content) ?? '-' : '';
    }

    function run(action) {
        try {
            const result = action();
            if (result?.catch) result.catch(error => toastr.error(error.message));
            return result;
        } catch (error) {
            toastr.error(error.message);
            return false;
        }
    }

    function menu(trigger, title, sections) {
        closePopover(false);
        openActionMenu({ trigger, title, sections: sections.map(items => ({ items: items.filter(Boolean) })) });
        document.querySelectorAll('.sb-action-menu, .sb-action-sheet').forEach(node => node.dataset.sbPromptMenu = 'true');
    }

    function menuItem(label, glyph, action, danger = false) {
        return { label, icon: `fa-solid fa-${glyph}`, onSelect: () => run(action), danger };
    }

    function toast(message, undo) {
        clearTimeout(toastTimer);
        root.querySelector('.sb-prompt-toast')?.remove();
        const node = element('div', 'sb-prompt-toast');
        node.setAttribute('role', 'status');
        node.append(element('span', '', message));
        if (undo) node.append(button(t`Undo`, null, () => {
            run(undo);
            node.remove();
            synchronize();
        }));
        root.append(node);
        play(node, [{ opacity: 0, transform: 'translateY(100%)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_SURFACE });
        toastTimer = setTimeout(() => {
            if (node.contains(document.activeElement)) return;
            play(node, [{ opacity: 1 }, { opacity: 0, transform: 'scale(0.95)' }], { duration: MOTION_SURFACE, onFinish: () => node.remove() });
        }, 5000);
    }

    function announceMove(id) {
        const order = state.order.filter(entry => promptFor(entry.identifier));
        const position = order.findIndex(entry => entry.identifier === id) + 1;
        const name = promptFor(id)?.name ?? '';
        status.textContent = t`Moved ${name} to position ${position} of ${order.length}`;
    }

    function move(id, position) {
        if (filter) return;
        const ids = state.order.filter(entry => promptFor(entry.identifier)).map(entry => entry.identifier);
        const previous = ids.indexOf(id);
        if (previous < 0) return;
        ids.splice(previous, 1);
        ids.splice(Math.max(0, Math.min(ids.length, position)), 0, id);
        run(() => model.reorder(ids, state.scope));
        state = model.snapshot();
        renderList();
        announceMove(id);
        rowFor(id)?.focus({ preventScroll: true });
    }

    async function remove(id) {
        if (draft && !(await allowLeave())) return;
        const expectedScope = state.scope;
        const name = promptFor(id)?.name;
        const row = rowFor(id);
        if (row) await new Promise(resolve => play(row, [{ opacity: 1 }, { opacity: 0, transform: 'translateX(12px)' }], { duration: MOTION_FAST, onEnd: resolve }));
        const removed = run(() => model.remove(id, expectedScope));
        if (!removed) return;
        if (draft?.identifier === id) closeNow();
        synchronize();
        toast(t`Removed ${name}`, () => model.undoRemove(removed));
    }

    async function deletePrompt(id) {
        if (draft && !(await allowLeave())) return;
        const expectedScope = state.scope;
        if (!await Popup.show.confirm(t`Are you sure you want to delete this prompt?`, null)) return;
        const result = run(() => model.delete(id, expectedScope));
        if (result === false) return;
        if (draft?.identifier === id) closeNow();
        synchronize();
    }

    async function rename(prompt) {
        if (draft && !(await allowLeave())) return;
        const row = rowFor(prompt.identifier);
        const name = row?.querySelector('.sb-prompt-row-name');
        if (!name || !model.permissions(prompt).rename) return;
        const expectedScope = state.scope;
        const input = element('input', 'sb-prompt-rename');
        input.value = prompt.name;
        input.setAttribute('aria-label', t`Prompt name`);
        name.replaceWith(input);
        input.focus();
        input.select();
        let finished = false;
        const finish = save => {
            if (finished) return;
            finished = true;
            input.replaceWith(name);
            if (save) run(() => model.rename(prompt.identifier, input.value, expectedScope));
            if (draft?.identifier === prompt.identifier && save) {
                draft.name = input.value;
                baseline = JSON.stringify(draft);
                renderEditor();
            }
            synchronize();
            rowFor(prompt.identifier)?.focus({ preventScroll: true });
        };
        input.addEventListener('keydown', event => {
            event.stopPropagation();
            if (!['Enter', 'Escape'].includes(event.key)) return;
            event.preventDefault();
            finish(event.key === 'Enter');
        });
        input.addEventListener('blur', () => finish(true));
    }

    function promptMenu(trigger, prompt, available) {
        const id = prompt.identifier;
        const permission = model.permissions(prompt);
        menu(trigger, prompt.name, [
            [permission.edit && menuItem(t`Edit`, 'pen', () => openPrompt(prompt)), permission.rename && menuItem(t`Rename`, 'i-cursor', () => rename(prompt)), menuItem(t`Preview`, 'eye', () => openPrompt(prompt, 'preview'))],
            available ? [] : [menuItem(t`Move to top`, 'arrow-up', () => move(id, 0)), menuItem(t`Move to bottom`, 'arrow-down', () => move(id, state.order.length - 1))],
            [!prompt.marker && menuItem(t`Send to agents`, 'robot', () => model.sendToAgents(id))],
            [!available && permission.remove && menuItem(t`Remove from list`, 'minus', () => remove(id), true), permission.delete && menuItem(t`Delete`, 'trash', () => deletePrompt(id), true)],
        ]);
    }

    function describe(prompt) {
        if (prompt.marker) return `${t`Marker`} · ${state.sources[prompt.identifier] ?? t`Generation time`}`;
        const position = Number(prompt.injection_position) === 1 ? `${t`In-chat`} @ ${prompt.injection_depth ?? 4}` : t`Relative`;
        return `${capitalized(prompt.role ?? 'system')} · ${position}${prompt.injection_trigger?.length ? ` · ${prompt.injection_trigger.map(capitalized).join(', ')}` : ''}`;
    }

    function makeRow(prompt, orderEntry = null, available = false, utility = false) {
        const textCompletion = textCompletionView();
        const id = textCompletion ? prompt.id : prompt.identifier;
        const nameText = translate(prompt.name);
        const row = element('div', 'sb-prompt-row');
        row.dataset.promptId = id;
        row.tabIndex = 0;
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-label', nameText);
        row.classList.toggle('is-selected', selectedId() === id);
        const disabledDrag = Boolean(filter);
        if (orderEntry) {
            const grip = element('div', 'sb-prompt-grip menu_button menu_button_icon ui-sortable-handle');
            grip.append(icon('grip-vertical'));
            grip.setAttribute('role', 'button');
            grip.setAttribute('aria-label', t`Drag to reorder ${nameText}`);
            grip.setAttribute('aria-disabled', String(disabledDrag));
            grip.title = grip.getAttribute('aria-label');
            row.append(grip);
        } else if (prompt.runtime) {
            const slot = element('span', 'sb-prompt-handle-slot');
            slot.setAttribute('aria-hidden', 'true');
            row.append(slot);
        }
        row.append(icon(textCompletion ? 'align-left' : utility ? 'file-lines' : prompt.runtime ? 'robot' : prompt.marker ? 'thumbtack' : Number(prompt.injection_position) === 1 ? 'syringe' : prompt.role === 'system' ? 'gear' : 'comment'));
        const text = element('div', 'sb-prompt-row-text');
        const name = element('span', 'sb-prompt-row-name', nameText);
        const preview = textCompletion
            ? Object.values(prompt.values).find(value => typeof value === 'string' && value.trim()) ?? ''
            : utility ? model.readUtility(id) : describe(prompt);
        text.append(name, element('span', 'sb-prompt-row-subtitle', textCompletion || utility ? preview.replace(/\s+/g, ' ').slice(0, 100) || '—' : preview));
        row.append(text);
        if (textCompletion) {
            if (textCompletionContent(prompt)) row.append(element('span', 'sb-prompt-token', String(knownTextCompletionCount(prompt))));
        } else if (!utility) row.append(element('span', 'sb-prompt-token', String(knownCount(prompt))));
        if (orderEntry) row.append(switchControl(t`Enable ${prompt.name}`, orderEntry.enabled, () => {
            run(() => model.toggle(id, state.scope));
            synchronize();
        }, !model.permissions(prompt).toggle));
        if (available) row.append(button(t`Add ${prompt.name}`, 'plus', () => {
            run(() => model.insert(id, state.scope));
            synchronize();
        }));
        if (!prompt.runtime) {
            const more = button(t`Actions for ${nameText}`, 'ellipsis-vertical', trigger => textCompletion
                ? menu(trigger, nameText, [[menuItem(t`Edit`, 'pen', () => openTextCompletion(prompt))]])
                : utility
                    ? menu(trigger, nameText, [[menuItem(t`Edit`, 'pen', () => openUtility(prompt)), model.canRestoreUtility(id) && menuItem(t`Restore default`, 'rotate-left', () => restoreUtility(id))]])
                    : promptMenu(trigger, prompt, available), 'sb-prompt-row-menu');
            more.setAttribute('aria-haspopup', 'menu');
            more.setAttribute('aria-expanded', 'false');
            row.append(more);
        } else {
            for (const className of ['sb-prompt-switch-slot', 'sb-prompt-row-menu sb-prompt-menu-slot']) {
                const slot = element('span', className);
                slot.setAttribute('aria-hidden', 'true');
                row.append(slot);
            }
        }
        const open = () => textCompletion ? openTextCompletion(prompt) : utility ? openUtility(prompt) : openPrompt(prompt, prompt.runtime ? 'inspect' : null);
        row.addEventListener('click', event => {
            if (event.target.closest('button, input, .sb-prompt-grip')) return;
            void open();
        });
        row.addEventListener('keydown', event => {
            if (event.target !== row && !event.target.closest('.sb-prompt-grip')) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void open();
            } else if (event.key === 'F2' && !utility && !textCompletion && !prompt.runtime) {
                event.preventDefault();
                void rename(prompt);
            } else if (event.altKey && orderEntry && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
                move(id, state.order.findIndex(entry => entry.identifier === id) + (event.key === 'ArrowUp' ? -1 : 1));
            }
        });
        if (!utility && !textCompletion && !prompt.marker) name.addEventListener('dblclick', event => {
            event.stopPropagation();
            void rename(prompt);
        });
        return row;
    }

    function group(title, className = '') {
        if (listGroups.has(className)) return listGroups.get(className);
        const section = element('section', `sb-prompt-section ${className}`);
        const heading = element('h3', '', title);
        heading.tabIndex = -1;
        const box = element('div', 'sb-prompt-box');
        box.setAttribute('role', 'list');
        section.append(heading, box);
        listBody.append(section);
        const result = { section, box, rows: new Map() };
        listGroups.set(className, result);
        return result;
    }

    function reconcileRows(group, entries) {
        const identifiers = new Set();
        let cursor = group.box.firstElementChild;
        for (const { prompt, orderEntry = null, available = false, utility = false } of entries) {
            const textCompletion = textCompletionView();
            const id = textCompletion ? prompt.id : prompt.identifier;
            identifiers.add(id);
            const signature = JSON.stringify([prompt, utility ? model.readUtility(id) : textCompletion ? prompt : [model.permissions(prompt), describe(prompt)]]);
            let cached = group.rows.get(id);
            if (!cached || cached.signature !== signature) {
                const row = makeRow(prompt, orderEntry, available, utility);
                if (cached) {
                    if (cursor === cached.row) cursor = cached.row.nextElementSibling;
                    cached.row.replaceWith(row);
                }
                cached = { row, signature };
                group.rows.set(id, cached);
            }
            const row = cached.row;
            const selected = selectedId() === id;
            const disabled = textCompletionView() ? Boolean(prompt.disabled) : orderEntry?.enabled === false;
            if (row.classList.contains('is-selected') !== selected) row.classList.toggle('is-selected', selected);
            if (row.classList.contains('is-disabled') !== disabled) row.classList.toggle('is-disabled', disabled);
            const grip = row.querySelector('.sb-prompt-grip');
            if (grip && grip.getAttribute('aria-disabled') !== String(Boolean(filter))) grip.setAttribute('aria-disabled', String(Boolean(filter)));
            const control = row.querySelector('input.sb-switch');
            if (control) {
                if (control.checked !== Boolean(orderEntry.enabled)) control.checked = Boolean(orderEntry.enabled);
            }
            const token = row.querySelector('.sb-prompt-token');
            const count = String(textCompletionView() ? knownTextCompletionCount(prompt) : knownCount(prompt));
            if (token && token.textContent !== count) token.textContent = count;
            if (row === cursor) cursor = cursor.nextElementSibling;
            else if (row.nextElementSibling !== cursor || row.parentElement !== group.box) {
                group.box.insertBefore(row, cursor);
            }
        }
        for (const [id, cached] of group.rows) {
            if (identifiers.has(id)) continue;
            cached.row.remove();
            group.rows.delete(id);
        }
    }

    function renderList() {
        if (transition || listPointerActive || listBody.querySelector('.ui-sortable-helper, .ui-sortable-placeholder')) {
            listRefreshPending = true;
            return;
        }
        const textCompletion = textCompletionView();
        for (const control of [addPromptButton, listActionsButton]) {
            if (control.hidden !== textCompletion) control.hidden = textCompletion;
        }
        const title = titles.querySelector('h2');
        const titleText = textCompletion ? t`Prompt templates` : t`Prompts`;
        if (title.textContent !== titleText) title.textContent = titleText;
        const sectionClasses = ['sb-prompt-order', 'sb-prompt-available', '', 'sb-prompt-tc-system', 'sb-prompt-tc-context', 'sb-prompt-tc-instruct'];
        for (const className of sectionClasses) {
            const section = listGroups.get(className)?.section;
            if (!section) continue;
            const hidden = textCompletion ? !className.startsWith('sb-prompt-tc-') : className.startsWith('sb-prompt-tc-');
            if (section.hidden !== hidden) section.hidden = hidden;
        }
        if (textCompletion) {
            clearTimeout(listTokenTimer);
            const nextKey = JSON.stringify([state.scope, state.textCompletionEntries, filter, selectedId(), kind]);
            if (nextKey === renderedListKey) return false;
            renderedListKey = nextKey;
            const matches = entry => translate(entry.name).toLowerCase().includes(filter.toLowerCase());
            for (const [section, className] of [
                ['System prompt', 'sb-prompt-tc-system'],
                ['Context', 'sb-prompt-tc-context'],
                ['Instruct', 'sb-prompt-tc-instruct'],
            ]) {
                const entries = state.textCompletionEntries.filter(entry => entry.section === section && matches(entry));
                reconcileRows(group(translate(section), className), entries.map(prompt => ({ prompt })));
            }
            updateListSubtitle();
            return true;
        }
        const utilities = UTILITY_FIELDS.map(([identifier, name]) => ({ identifier, name: translate(name), content: model.readUtility(identifier) }));
        const nextKey = JSON.stringify([state.scope, state.prompts, state.order, state.counts, state.sources, state.error, state.runtime, state.character?.name, utilities, filter, selectedId(), tokenizerKey]);
        if (nextKey === renderedListKey) return false;
        renderedListKey = nextKey;
        const focused = listBody.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.closest('[data-prompt-id]')?.dataset.promptId;
        const matches = prompt => prompt.name.toLowerCase().includes(filter.toLowerCase());
        const rows = state.order.flatMap(entry => {
            const prompt = promptFor(entry.identifier);
            return prompt && matches(prompt) ? [{ prompt, orderEntry: entry }] : [];
        });
        // The assembled Agents row is inspection-only and never enters persisted order data.
        if (matches(state.runtime)) rows.push({ prompt: state.runtime });
        const order = group(t`Prompt order`, 'sb-prompt-order');
        reconcileRows(order, rows);
        const box = order.box;
        const error = listBody.querySelector('.sb-prompt-error');
        if (!state.error) error?.remove();
        else if (!error) listBody.prepend(element('div', 'sb-prompt-error', state.error));
        else if (error.textContent !== state.error) error.textContent = state.error;
        const available = state.prompts.filter(prompt => !state.order.some(entry => entry.identifier === prompt.identifier));
        reconcileRows(group(t`Available`, 'sb-prompt-available'), available.filter(matches).map(prompt => ({ prompt, available: true })));
        reconcileRows(group(t`Utility prompts`), utilities.filter(matches).map(prompt => ({ prompt, utility: true })));
        updateListSubtitle();
        let dragScope = state.scope;
        if ($.fn.sortable && !box.classList.contains('ui-sortable')) $(box).sortable({
            handle: '.sb-prompt-grip', axis: 'y', delay: mobile.matches ? 30 : 0, distance: 4,
            cancel: 'input,textarea,button,select,option', items: '> .sb-prompt-row:has(.sb-prompt-grip)',
            disabled: Boolean(filter),
            start: () => dragScope = state.scope,
            update: (_event, ui) => {
                const ids = [...box.children].filter(row => row.querySelector('.sb-prompt-grip')).map(row => row.dataset.promptId);
                run(() => model.reorder(ids, dragScope));
                state = model.snapshot();
                const id = ui.item[0].dataset.promptId;
                announceMove(id);
                rowFor(id)?.focus({ preventScroll: true });
            },
            stop: () => requestAnimationFrame(() => {
                if (!listRefreshPending) return;
                listRefreshPending = false;
                renderList();
            }),
        });
        else if ($.fn.sortable) {
            // Sortable refreshes items and positions on drag start; doing so here forces a full layout.
            if ($(box).sortable('option', 'disabled') !== Boolean(filter)) $(box).sortable('option', 'disabled', Boolean(filter));
        }
        if (focusedId && !focused.isConnected) rowFor(focusedId)?.focus({ preventScroll: true });
        scheduleListTokens();
        return true;
    }

    function updateListSubtitle() {
        if (textCompletionView()) {
            const value = t`Text completion · Grouped by role`;
            if (subtitle.textContent !== value) subtitle.textContent = value;
            return;
        }
        const enabled = state.order.filter(entry => entry.enabled && promptFor(entry.identifier));
        const counts = enabled.map(entry => promptFor(entry.identifier)).filter(Boolean).map(knownCount).filter(count => typeof count === 'number');
        subtitle.textContent = state.strategy === 'character' && state.character?.name
            ? t`Order for ${state.character.name}`
            : t`${enabled.length} active · ${counts.length ? counts.reduce((sum, count) => sum + count, 0) : '-'} tokens`;
    }

    function scheduleListTokens() {
        clearTimeout(listTokenTimer);
        listTokenTimer = setTimeout(async () => {
            if (transition) { scheduleListTokens(); return; }
            const expectedScope = state.scope;
            const expectedTokenizer = tokenizerKey;
            if (textCompletionView()) {
                for (const entry of state.textCompletionEntries) {
                    const content = textCompletionContent(entry);
                    if (!content || contentCounts.has(content)) continue;
                    try {
                        const count = await countContent(content);
                        if (state.scope !== expectedScope || tokenizerKey !== expectedTokenizer || !textCompletionView()) return;
                        const token = rowFor(entry.id)?.querySelector('.sb-prompt-token');
                        if (token && !transition && token.textContent !== String(count)) token.textContent = String(count);
                    } catch { return; }
                }
                return;
            }
            const prompts = [...listBody.querySelectorAll('[data-prompt-id]')].map(row => promptFor(row.dataset.promptId)).filter(prompt => prompt && !prompt.marker && prompt.content && knownCount(prompt) === '-');
            for (const prompt of prompts) {
                if (knownCount(prompt) !== '-') continue;
                const content = prompt.content;
                try {
                    const count = await countContent(content);
                    if (state.scope !== expectedScope || tokenizerKey !== expectedTokenizer) return;
                    if (promptFor(prompt.identifier)?.content !== content) continue;
                    const token = rowFor(prompt.identifier)?.querySelector('.sb-prompt-token');
                    if (token && !transition) token.textContent = String(count);
                } catch { return; }
            }
            if (!transition) updateListSubtitle();
        }, 300);
    }

    function toggleSearch() {
        const show = searchField.hidden;
        stopMotion(searchField);
        const height = `${parseFloat(getComputedStyle(searchField).getPropertyValue('--sb-prompt-search-height')) || 40}px`;
        if (show) {
            searchField.hidden = false;
            play(searchField, [{ height: '0px', marginBlock: '0px', opacity: 0 }, { height, marginBlock: '8px', opacity: 1 }], { duration: MOTION_SLOW });
            search.focus({ preventScroll: true });
            return;
        }
        animateOut(searchField, [{ height, marginBlock: '8px', opacity: 1 }, { height: '0px', marginBlock: '0px', opacity: 0 }], () => searchField.hidden = true, { duration: MOTION_SLOW });
        search.value = '';
        filter = '';
        renderList();
    }

    listHeader.append(titles, button(t`Search prompts`, 'magnifying-glass', toggleSearch));
    const addPromptButton = button(t`Add prompt`, 'plus', trigger => {
        const count = state.prompts.filter(prompt => !state.order.some(entry => entry.identifier === prompt.identifier)).length;
        menu(trigger, t`Add prompt`, [[
            menuItem(t`New prompt`, 'plus', async () => {
                if (!(await allowLeave())) return;
                await openDraft(model.newDraft(), 'prompt', 'edit', true);
            }),
            { ...menuItem(t`Add from available (${count})`, 'folder-open', () => {
                filter = '';
                search.value = '';
                renderList();
                const section = listBody.querySelector('.sb-prompt-available');
                const top = listBody.scrollTop + section.getBoundingClientRect().top - listBody.getBoundingClientRect().top;
                listBody.scrollTo({ top, behavior: document.body.classList.contains('reduced-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
                section.querySelector('h3').focus({ preventScroll: true });
            }), disabled: count === 0 },
        ]]);
    });
    const listActionsButton = button(t`Prompt list actions`, 'ellipsis-vertical', trigger => menu(trigger, t`Prompt list`, [
        [menuItem(t`Import prompt list`, 'file-import', async () => { if (await allowLeave()) model.importList(); }), menuItem(t`Export prompt list`, 'file-export', () => model.exportList()), state.strategy === 'character' && state.character && menuItem(t`Export character prompts`, 'file-export', () => model.exportCharacter())],
        [menuItem(t`Reset order`, 'rotate-left', async () => { if (await allowLeave()) model.resetOrder(); })],
    ]));
    listHeader.append(addPromptButton, listActionsButton);
    for (const trigger of listHeader.querySelectorAll('button:not(:first-of-type)')) {
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
    }
    search.addEventListener('input', () => { filter = search.value; renderList(); });
    search.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        toggleSearch();
    });
    list.addEventListener('pointerdown', event => {
        if (event.target.closest('.sb-prompt-grip[aria-disabled="false"]')) listPointerActive = true;
    }, true);
    const finishListPointer = () => {
        if (!listPointerActive) return;
        listPointerActive = false;
        requestAnimationFrame(() => {
            if (!listRefreshPending) return;
            listRefreshPending = false;
            renderList();
        });
    };
    window.addEventListener('pointerup', finishListPointer, true);
    window.addEventListener('pointercancel', finishListPointer, true);
    window.addEventListener('blur', finishListPointer);

    async function allowLeave() {
        if (!dirty()) return true;
        if (busy) return false;
        busy = true;
        const popup = new Popup(element('p', '', t`Unsaved changes`), POPUP_TYPE.CONFIRM, '', {
            okButton: t`Save`, cancelButton: t`Cancel`, customButtons: [{ text: t`Discard`, result: 2 }], defaultResult: POPUP_RESULT.NEGATIVE,
        });
        popup.cancelButton.style.order = '0';
        popup.okButton.style.order = '2';
        const result = await popup.show();
        busy = false;
        if (result === POPUP_RESULT.AFFIRMATIVE) return save();
        if (result !== 2) return false;
        const live = kind === 'utility'
            ? { ...draft, content: model.readUtility(draft.identifier) }
            : kind === 'text-completion' ? model.readTextCompletionEntry(draft.identifier) : promptFor(draft.identifier);
        if (!live) {
            closeNow();
            return true;
        }
        draft = structuredClone(live);
        draftScope = state.scope;
        baseline = JSON.stringify(draft);
        renderEditor();
        return true;
    }

    function save() {
        if (!draft || !dirty()) return true;
        if (kind === 'prompt' && run(() => model.save(draft, draftScope)) === false) return false;
        if (kind === 'utility') {
            if (run(() => model.saveUtility(draft, draftScope)) === false) return false;
        }
        if (kind === 'text-completion' && run(() => model.saveTextCompletion(draft, draftScope)) === false) return false;
        baseline = JSON.stringify(draft);
        updateDirty();
        synchronize();
        status.textContent = t`Saved`;
        return true;
    }

    function markDirty() {
        updateDirty();
        if (kind !== 'text-completion') scheduleTokens();
    }

    function updateDirty() {
        const dot = editor.querySelector('.sb-prompt-dirty');
        const saveButton = editor.querySelector('.sb-prompt-save');
        if (!dot || !saveButton) return;
        const isDirty = dirty();
        const changed = dot.hidden === isDirty;
        const disabled = !isDirty || (kind === 'prompt' && !model.permissions(draft).edit);
        if (saveButton.disabled !== disabled) saveButton.disabled = disabled;
        if (!changed) return;
        if (isDirty) {
            dot.hidden = false;
            play(dot, [{ opacity: 0, transform: 'scale(0.7)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_FAST });
        } else animateOut(dot, [{ opacity: 1 }, { opacity: 0 }], () => dot.hidden = true, { duration: MOTION_POPOVER_CLOSE, onEnd: scheduleLayout });
        scheduleLayout();
    }

    async function openPrompt(prompt, requestedMode = null) {
        if (draft?.identifier === prompt.identifier && requestedMode === null) return closeEditor();
        if (!(await allowLeave())) return;
        const nextMode = requestedMode ?? (model.permissions(prompt).edit ? 'edit' : 'preview');
        await openDraft(prompt, 'prompt', nextMode);
    }

    async function openUtility(prompt) {
        if (!(await allowLeave())) return;
        await openDraft({ ...prompt, content: model.readUtility(prompt.identifier) }, 'utility', 'edit');
    }

    async function openTextCompletion(entry) {
        if (draft?.identifier === entry.identifier && kind === 'text-completion') return closeEditor();
        if (!(await allowLeave())) return;
        await openDraft(model.readTextCompletionEntry(entry.identifier), 'text-completion', 'edit');
    }

    async function restoreUtility(identifier) {
        if (!(await allowLeave())) return;
        if (run(() => model.restoreUtility(identifier, state.scope)) === false) return;
        synchronize();
    }

    async function openDraft(value, nextKind, nextMode, isNew = false) {
        cancelNavigation();
        closeOverlays();
        const wasOpen = Boolean(draft);
        const startWidth = list.getBoundingClientRect().width;
        draft = structuredClone(value);
        kind = nextKind;
        mode = nextMode;
        draftScope = state.scope;
        baseline = isNew ? '' : JSON.stringify(draft);
        returningId = draft.identifier;
        root.dataset.open = 'true';
        renderEditor();
        renderList();
        layout();
        if (!wasOpen) navigate(true, startWidth);
        else play(editor.querySelector('.sb-prompt-content'), [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
        editor.querySelector('.sb-prompt-title')?.focus({ preventScroll: true });
    }

    async function closeEditor() {
        if (!(await allowLeave())) return;
        cancelNavigation();
        closeOverlays();
        const startWidth = list.getBoundingClientRect().width;
        draft = null;
        list.inert = false;
        root.dataset.open = 'false';
        navigate(false, startWidth);
        rowFor(returningId)?.focus({ preventScroll: true });
    }

    function closeNow() {
        draft = null;
        cancelNavigation();
        closeOverlays();
        root.dataset.open = 'false';
        editor.hidden = true;
        layout();
    }

    function cancelNavigation() {
        if (transition) {
            const previous = transition;
            transition = null;
            cancelAnimationFrame(previous.startFrame);
            previous.handles.forEach(handle => handle?.cancel());
        }
        for (const node of [list, editor]) {
            stopMotion(node);
            for (const property of ['width', 'transform', 'opacity', 'will-change']) node.style.removeProperty(property);
        }
        if (editor.classList.contains('sb-prompt-travelling')) editor.classList.remove('sb-prompt-travelling');
        if (editor.hidden !== !draft) editor.hidden = !draft;
        if (editor.inert !== !draft) editor.inert = !draft;
        const listInert = collapsed && Boolean(draft);
        if (list.inert !== listInert) list.inert = listInert;
        if (listRefreshPending) { listRefreshPending = false; renderList(); }
    }

    function navigate(opening, startWidth) {
        const frame = { handles: [], remaining: 2, startFrame: 0 };
        transition = frame;
        editor.hidden = false;
        editor.inert = !opening;
        editor.classList.add('sb-prompt-travelling');
        // Width intentionally reflows the list; the editor keeps its settled width and slides over it.
        editor.style.width = `${collapsed ? root.clientWidth : root.clientWidth - listWidth() - 1}px`;
        editor.style.transform = opening ? 'translateX(100%)' : 'none';
        list.style.width = `${startWidth}px`;
        if (collapsed) {
            list.style.transform = opening ? 'none' : 'translateX(-26%)';
            list.style.opacity = opening ? '1' : '0.42';
        }
        const finish = () => {
            if (transition !== frame || --frame.remaining) return;
            transition = null;
            cancelNavigation();
            layout();
            renderList();
        };
        const start = () => {
            if (transition !== frame) return;
            frame.handles.push(play(editor, opening
                ? [{ transform: 'translateX(100%)' }, { transform: 'none' }]
                : [{ transform: 'none' }, { transform: 'translateX(100%)' }], { ...SPRING_NAVIGATION, fill: 'both', onEnd: finish }));
            frame.handles.push(play(list, collapsed
                ? opening ? [{ transform: 'none', opacity: 1 }, { transform: 'translateX(-26%)', opacity: 0.42 }] : [{ transform: 'translateX(-26%)', opacity: 0.42 }, { transform: 'none', opacity: 1 }]
                : [{ width: `${startWidth}px` }, { width: `${opening ? listWidth() : root.clientWidth}px` }], { ...SPRING_NAVIGATION, fill: 'both', onEnd: finish }));
        };
        // Settle the new editor DOM and its container-query layout before the first animation frame.
        editor.getBoundingClientRect();
        if (prefersReducedMotion()) start();
        else frame.startFrame = requestAnimationFrame(start);
    }

    function property(label, control) {
        const node = element('div', 'sb-prompt-property');
        node.append(element('span', '', label), control);
        return node;
    }

    function segmented(label, choices, value, change) {
        // The prompt sheet scopes its own pill styling (sillybunny-prompt-editor.css:601).
        return createSegmentedControl(label, choices, value, change, { compact: false });
    }

    function closePopover(animate = true, restoreFocus = false) {
        if (!overlay) return;
        const current = overlay;
        overlay = null;
        current.trigger.setAttribute('aria-expanded', 'false');
        current.trigger.removeAttribute('aria-controls');
        current.node.inert = true;
        if (restoreFocus) current.trigger.focus({ preventScroll: true });
        if (!animate) { stopMotion(current.node); current.node.remove(); return; }
        play(current.node, [{ opacity: 1 }, { opacity: 0 }], { duration: MOTION_POPOVER_CLOSE, onFinish: () => current.node.remove() });
    }

    function showPopover(trigger, node, focusTarget = node) {
        closePopover(false);
        document.querySelectorAll('.sb-prompt-popover[inert]').forEach(previous => { stopMotion(previous); previous.remove(); });
        closeActionMenu({ animate: false, restoreFocus: false });
        overlay = { trigger, node };
        trigger.setAttribute('aria-expanded', 'true');
        document.body.append(node);
        blockUpstreamDrawerClose(node);
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(Math.max(208, rect.width), innerWidth - 16);
        node.style.width = `${width}px`;
        node.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
        node.style.top = `${innerHeight - rect.bottom > node.offsetHeight + 14 ? rect.bottom + 6 : Math.max(8, rect.top - node.offsetHeight - 6)}px`;
        play(node, [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: MOTION_FAST, easing: MOTION_EASE_OUT_CUBIC });
        focusTarget.focus({ preventScroll: true });
        node.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            closePopover(true, true);
        });
    }

    function roleControl() {
        const choices = [['system', t`System`], ['user', t`User`], ['assistant', t`Assistant`]];
        const label = element('span', '', choices.find(([value]) => value === (draft.role ?? 'system'))[1]);
        const trigger = button(t`Role`, null, () => {
            if (overlay?.trigger === trigger) { closePopover(true, true); return; }
            const node = element('div', 'sb-prompt-popover sb-prompt-role-list');
            node.setAttribute('role', 'listbox');
            node.setAttribute('aria-label', t`Role`);
            node.tabIndex = 0;
            let activeIndex = Math.max(0, choices.findIndex(([value]) => value === (draft.role ?? 'system')));
            const options = choices.map(([value, text], index) => {
                const option = element('div', 'sb-prompt-option');
                option.id = `sb-prompt-role-${index}`;
                option.setAttribute('role', 'option');
                option.setAttribute('aria-selected', String(value === (draft.role ?? 'system')));
                option.append(icon('check'), element('span', '', text));
                option.addEventListener('pointermove', () => { activeIndex = index; update(); });
                option.addEventListener('click', () => choose(index));
                return option;
            });
            const update = () => {
                options.forEach((option, index) => option.classList.toggle('is-active', index === activeIndex));
                node.setAttribute('aria-activedescendant', options[activeIndex].id);
            };
            const choose = index => {
                draft.role = choices[index][0];
                label.textContent = choices[index][1];
                markDirty();
                refreshSummary();
                closePopover(true, true);
            };
            node.append(...options);
            node.addEventListener('keydown', event => {
                if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) event.preventDefault();
                if (event.key === 'ArrowDown') activeIndex = (activeIndex + 1) % choices.length;
                if (event.key === 'ArrowUp') activeIndex = (activeIndex + choices.length - 1) % choices.length;
                if (event.key === 'Home') activeIndex = 0;
                if (event.key === 'End') activeIndex = choices.length - 1;
                if (event.key === 'Enter' || event.key === ' ') choose(activeIndex);
                if (event.key === 'Tab') closePopover(true, true);
                update();
            });
            update();
            showPopover(trigger, node);
        }, 'sb-prompt-dropdown');
        trigger.replaceChildren(label, icon('chevron-down'));
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
            event.preventDefault();
            trigger.click();
        });
        return trigger;
    }

    function triggerSummary() {
        return draft.injection_trigger?.length ? draft.injection_trigger.map(capitalized).join(', ') : t`All triggers`;
    }

    function triggersControl() {
        const label = element('span', '', triggerSummary());
        const trigger = button(t`Triggers`, null, () => {
            if (overlay?.trigger === trigger) { closePopover(true, true); return; }
            const node = element('div', 'sb-prompt-popover');
            node.setAttribute('role', 'dialog');
            node.setAttribute('aria-label', t`Generation triggers`);
            node.tabIndex = -1;
            for (const value of TRIGGERS) {
                const row = element('label', 'sb-prompt-trigger-row');
                const input = element('input');
                input.type = 'checkbox';
                input.checked = draft.injection_trigger?.includes(value) ?? false;
                input.addEventListener('change', () => {
                    const values = new Set(draft.injection_trigger ?? []);
                    if (input.checked) values.add(value);
                    else values.delete(value);
                    draft.injection_trigger = TRIGGERS.filter(item => values.has(item));
                    label.textContent = triggerSummary();
                    markDirty();
                    refreshSummary();
                });
                row.append(input, element('span', '', translate(capitalized(value))));
                node.append(row);
            }
            node.append(button(t`Done`, null, () => closePopover(true, true)));
            showPopover(trigger, node, node.querySelector('input'));
        }, 'sb-prompt-dropdown');
        trigger.replaceChildren(label, icon('chevron-down'));
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        return trigger;
    }

    function properties() {
        if (kind === 'text-completion') return textCompletionProperties();
        const props = element('div', 'sb-prompt-properties');
        props.append(property(t`Role`, roleControl()), property(t`Position`, segmented(t`Position`, [[0, t`Relative`], [1, t`In-chat`]], draft.injection_position ?? 0, value => {
            draft.injection_position = value;
            markDirty();
            refreshProperties();
        })));
        if (Number(draft.injection_position) === 1) {
            for (const [key, label, fallback] of [['injection_depth', t`Depth`, 4], ['injection_order', t`Order`, 100]]) {
                const input = element('input');
                input.type = 'number';
                input.value = draft[key] ?? fallback;
                input.setAttribute('aria-label', label);
                input.addEventListener('input', () => {
                    if (!Number.isFinite(input.valueAsNumber)) return;
                    draft[key] = input.valueAsNumber;
                    markDirty();
                    refreshSummary();
                });
                props.append(property(label, input));
            }
        }
        props.append(property(t`Triggers`, triggersControl()));
        if (['main', 'jailbreak'].includes(draft.identifier)) props.append(property(t`Forbid overrides`, switchControl(t`Forbid overrides`, draft.forbid_overrides, value => {
            draft.forbid_overrides = value;
            markDirty();
        })));
        return props;
    }

    function textCompletionProperties() {
        const props = element('div', 'sb-prompt-properties sb-prompt-tc-properties');
        if (!draft.properties?.length) return props;
        for (const descriptor of draft.properties) {
            const label = translate(descriptor.name);
            const value = draft.propertyValues[descriptor.id];
            let control;
            if (descriptor.id === 'context_story_string_position' || descriptor.id === 'context_story_string_role') {
                const source = document.getElementById(descriptor.id);
                control = element('select');
                if (source instanceof HTMLSelectElement) {
                    for (const option of source.options) {
                        const copy = element('option', '', option.textContent);
                        copy.value = option.value;
                        copy.selected = option.value === String(value);
                        control.append(copy);
                    }
                }
                control.setAttribute('aria-label', label);
                control.addEventListener('change', () => {
                    draft.propertyValues[descriptor.id] = control.value;
                    markDirty();
                    refreshSummary();
                });
            } else {
                control = element('input');
                control.type = 'number';
                control.value = value ?? '';
                control.setAttribute('aria-label', label);
                control.addEventListener('input', () => {
                    if (!Number.isFinite(control.valueAsNumber)) return;
                    draft.propertyValues[descriptor.id] = control.valueAsNumber;
                    markDirty();
                    refreshSummary();
                });
            }
            props.append(property(label, control));
        }
        return props;
    }

    function refreshSummary() {
        const summary = editor.querySelector('.sb-prompt-property-summary');
        if (!summary) return;
        if (kind === 'text-completion') {
            const position = draft.propertyValues.context_story_string_position;
            const depth = draft.propertyValues.context_story_string_depth;
            summary.textContent = `${t`Story string`} · ${t`Position`} ${position} · ${t`Depth`} ${depth} ›`;
            return;
        }
        summary.textContent = `${capitalized(draft.role ?? 'system')} · ${Number(draft.injection_position) === 1 ? `${t`In-chat`} @ ${draft.injection_depth ?? 4}` : t`Relative`} · ${triggerSummary()} ›`;
    }

    function refreshProperties() {
        closePopover(false);
        editor.querySelector('.sb-prompt-properties')?.replaceWith(properties());
        propertySheet?.querySelector('.sb-prompt-properties')?.replaceWith(properties());
        refreshSummary();
    }

    function openProperties(trigger) {
        closeOverlays();
        const scrim = element('button', 'sb-prompt-sheet-backdrop');
        scrim.type = 'button';
        scrim.tabIndex = -1;
        scrim.hidden = true;
        scrim.setAttribute('aria-label', t`Close prompt properties`);
        const sheet = element('div', 'sb-prompt-sheet');
        sheet.hidden = true;
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-labelledby', 'sb-prompt-properties-title');
        const heading = element('h2', '', t`Prompt properties`);
        heading.id = 'sb-prompt-properties-title';
        heading.tabIndex = -1;
        const header = element('header', 'sb-prompt-sheet-header');
        header.append(heading, button(t`Close prompt properties`, 'xmark', () => sheetController.close()));
        sheet.append(header, properties());
        document.body.append(scrim, sheet);
        propertySheet = sheet;
        sheetController = createSheetController({ sheet, backdrop: scrim, getInitialFocus: () => heading, getReturnFocus: () => trigger, onClose: () => { closePopover(false); if (draft) refreshProperties(); } });
        sheetController.open();
    }

    function closeOverlays() {
        closeActionMenu({ animate: false, restoreFocus: false });
        closePopover(false);
        sheetController?.close({ animate: false, restoreFocus: false });
        sheetController = null;
        propertySheet?.remove();
        propertySheet = null;
        document.querySelectorAll('.sb-prompt-sheet-backdrop').forEach(node => node.remove());
    }

    function setMode(value) {
        cancelNavigation();
        mode = value;
        renderEditor();
        play(editor.querySelector('.sb-prompt-content'), [{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_FAST });
    }

    function renderEditor() {
        if (!draft) return;
        closePopover(false);
        editor.hidden = false;
        editor.inert = false;
        editor.dataset.disabled = String(kind === 'text-completion' && draft.disabled);
        editor.replaceChildren();
        const header = element('header', 'sb-prompt-detail-header');
        header.append(button(t`Back to prompt list`, 'chevron-left', closeEditor));
        const title = element('input', 'sb-prompt-title');
        title.id = 'sb-prompt-form_name';
        title.value = draft.name;
        title.readOnly = kind !== 'prompt' || !model.permissions(draft).rename;
        title.setAttribute('aria-label', t`Prompt name`);
        title.addEventListener('input', () => { draft.name = title.value; markDirty(); });
        const dot = element('span', 'sb-prompt-dirty', '•');
        dot.setAttribute('aria-label', t`Unsaved changes`);
        dot.hidden = !dirty();
        header.append(title, dot);
        const modes = segmented(t`Editor mode`, [['edit', t`Edit`], ['preview', t`Preview`]], mode, setMode);
        modes.classList.add('sb-prompt-modes');
        header.append(modes, button(mode === 'edit' ? t`Preview prompt` : t`Edit prompt`, mode === 'edit' ? 'eye' : 'pen', () => setMode(mode === 'edit' ? 'preview' : 'edit'), 'sb-prompt-mode-toggle'));
        const actionGroup = element('div', 'sb-prompt-actions');
        const permission = kind === 'prompt' ? model.permissions(draft) : {};
        const persisted = kind === 'prompt' && (Boolean(promptFor(draft.identifier)) || draft.runtime);
        const items = [
            kind === 'utility' && model.canRestoreUtility(draft.identifier) && { label: t`Restore default`, glyph: 'rotate-left', action: () => restoreUtility(draft.identifier) },
            persisted && { label: t`Inspect`, glyph: 'list-check', action: () => setMode('inspect') },
            persisted && !draft.marker && { label: t`Send to agents`, glyph: 'robot', action: () => model.sendToAgents(draft.identifier) },
            permission.remove && state.order.some(entry => entry.identifier === draft.identifier) && { label: t`Remove from list`, glyph: 'minus', action: () => remove(draft.identifier) },
            persisted && permission.delete && { label: t`Delete`, glyph: 'trash', action: () => deletePrompt(draft.identifier), danger: true },
            permission.reset && { label: t`Reset to default`, glyph: 'rotate-left', action: () => { draft = model.resetDraft(draft); renderEditor(); markDirty(); } },
        ].filter(Boolean);
        actions = items.map(item => {
            const control = button(item.label, item.glyph, () => run(item.action), item.danger ? 'is-destructive' : '');
            actionGroup.append(control);
            return { ...item, control };
        });
        menuTrigger = button(t`More prompt actions`, 'ellipsis-vertical', trigger => menu(trigger, draft.name, [actions.filter(item => item.control.hidden).map(item => menuItem(item.label, item.glyph, item.action, item.danger))]));
        menuTrigger.setAttribute('aria-haspopup', 'menu');
        menuTrigger.setAttribute('aria-expanded', 'false');
        actionGroup.append(menuTrigger);
        header.append(actionGroup, button(t`Save`, null, save, 'menu_button_primary sb-prompt-save'));
        editor.append(header);
        if ((kind === 'prompt' && permission.edit || kind === 'text-completion' && draft.properties?.length) && mode !== 'inspect') {
            const summary = button('', null, openProperties, 'sb-prompt-property-summary');
            summary.setAttribute('aria-label', t`Prompt properties`);
            editor.append(summary, properties());
            refreshSummary();
        }
        const content = element('div', 'sb-prompt-content');
        if (mode === 'inspect') {
            const messages = model.inspect(draft.identifier);
            const block = element('div', 'sb-prompt-preview');
            block.tabIndex = 0;
            for (const message of messages) {
                const details = element('details', 'sb-prompt-inspect-message');
                details.append(element('summary', '', `${message.name} · ${message.role} · ${message.tokens} ${t`tokens`}`), element('pre', '', message.content));
                block.append(details);
            }
            if (!messages.length) block.textContent = t`(Empty prompt)`;
            content.append(block);
        } else if (mode === 'preview' && kind !== 'text-completion') {
            const block = element('pre', 'sb-prompt-preview', kind === 'prompt' ? run(() => model.preview(draft)) || t`(Empty prompt)` : draft.content);
            block.tabIndex = 0;
            content.append(block);
        } else if (kind === 'text-completion') {
            for (const field of draft.fields) {
                const label = translate(field.name);
                const value = draft.values[field.id];
                if (typeof value === 'boolean') {
                    const row = property(label, switchControl(label, value, checked => {
                        draft.values[field.id] = checked;
                        markDirty();
                        for (const relatedId of ['instruct_system_sequence', 'instruct_system_suffix']) {
                            const related = content.querySelector(`[data-tc-field="${relatedId}"]`);
                            if (related) {
                                related.readOnly = checked;
                                related.closest('.sb-prompt-content-field')?.classList.toggle('is-disabled', checked);
                            }
                        }
                    }));
                    row.classList.add('sb-prompt-tc-toggle');
                    content.append(row);
                    continue;
                }
                const fieldNode = element('label', 'sb-prompt-content-field sb-prompt-tc-field');
                fieldNode.append(element('span', 'sb-prompt-field-label', label));
                if (mode === 'preview') {
                    fieldNode.append(element('pre', 'sb-prompt-preview', String(value ?? '') || '—'));
                } else {
                    const textarea = element('textarea', 'sb-prompt-textarea sb-prompt-tc-textarea');
                    textarea.value = value ?? '';
                    textarea.dataset.tcField = field.id;
                    textarea.setAttribute('aria-label', label);
                    textarea.spellcheck = false;
                    const followsUser = ['instruct_system_sequence', 'instruct_system_suffix'].includes(field.id) && Boolean(draft.values.instruct_system_same_as_user);
                    textarea.readOnly = followsUser;
                    fieldNode.classList.toggle('is-disabled', followsUser);
                    textarea.addEventListener('input', () => {
                        draft.values[field.id] = textarea.value;
                        markDirty();
                    });
                    fieldNode.append(textarea);
                }
                content.append(fieldNode);
            }
        } else {
            const textarea = element('textarea', 'sb-prompt-textarea');
            textarea.id = 'sb-prompt-form_prompt';
            textarea.value = draft.marker ? run(() => model.preview(draft)) || '' : draft.content ?? '';
            textarea.readOnly = Boolean(draft.marker);
            if (draft.marker) textarea.placeholder = state.sources[draft.identifier] ?? t`Generation time`;
            textarea.setAttribute('aria-label', t`Prompt content`);
            textarea.spellcheck = false;
            textarea.addEventListener('input', () => { draft.content = textarea.value; markDirty(); });
            content.append(textarea);
        }
        const footer = element('footer', 'sb-prompt-footer');
        footer.append(element('span', 'sb-prompt-token-footer', kind === 'text-completion' ? '' : `${state.counts[draft.identifier] ?? '-'} ${t`tokens`}`));
        if (kind === 'text-completion' && draft.disabled) footer.append(element('span', '', t`Disabled`));
        if (state.sources?.[draft.identifier]) footer.append(element('span', '', `${t`Source`}: ${state.sources[draft.identifier]}`));
        editor.append(content, footer);
        updateDirty();
        if (observedHeader) resizeObserver.unobserve(observedHeader);
        observedHeader = header;
        resizeObserver.observe(header);
        scheduleLayout();
        scheduleTokens();
    }

    function scheduleTokens() {
        clearTimeout(tokenTimer);
        if (kind === 'text-completion') return;
        const request = ++tokenRequest;
        tokenTimer = setTimeout(async () => {
            if (!draft || draft.marker) return;
            if (transition) { scheduleTokens(); return; }
            try {
                const count = await countContent(draft.content || '');
                if (request !== tokenRequest || !draft) return;
                const footer = editor.querySelector('.sb-prompt-token-footer');
                if (footer) footer.textContent = `${count} ${t`tokens`}`;
            } catch {
                if (request !== tokenRequest) return;
                const footer = editor.querySelector('.sb-prompt-token-footer');
                if (footer) footer.textContent = `? ${t`tokens`}`;
            }
        }, 300);
    }

    function measureActions() {
        const header = editor.querySelector('.sb-prompt-detail-header');
        if (!header || !draft || transition) return;
        const title = header.querySelector('.sb-prompt-title');
        const group = header.querySelector('.sb-prompt-actions');
        const fixed = [...header.children].filter(node => node !== title && node !== group && getComputedStyle(node).display !== 'none');
        const style = getComputedStyle(header);
        const fixedWidth = fixed.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
        const available = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - fixedWidth - (parseFloat(getComputedStyle(title).minWidth) || 96) - (fixed.length + 2) * (parseFloat(style.gap) || 0);
        let count = mobile.matches ? 0 : actions.length;
        while (count > 0 && count * 42 + (count < actions.length ? 40 : 0) > available) count--;
        const active = document.activeElement;
        const focusWillHide = actions.some((item, index) => item.control === active && index >= count)
            || active === menuTrigger && count === actions.length;
        return { count, title, group, focusWillHide };
    }

    function updateActions(measurement) {
        if (!measurement) return;
        const { count, title, group, focusWillHide } = measurement;
        actions.forEach((item, index) => {
            if (item.control.hidden !== (index >= count)) item.control.hidden = index >= count;
        });
        if (menuTrigger.hidden !== (count === actions.length)) menuTrigger.hidden = count === actions.length;
        if (group.hidden !== (actions.length === 0)) group.hidden = actions.length === 0;
        if (focusWillHide) title.focus({ preventScroll: true });
    }

    function scheduleLayout() {
        if (layoutFrame || transition) return;
        layoutFrame = requestAnimationFrame(() => {
            layoutFrame = 0;
            layout();
        });
    }

    function layout() {
        if (transition) return;
        const width = root.clientWidth;
        if (!width) return;
        const nextCollapsed = mobile.matches || width < 720;
        const nextListWidth = Math.max(240, Math.min(420, sidebarWidth || width * 0.3));
        const hideCollapsed = Boolean(draft) && nextCollapsed;
        const card = column.querySelector(':scope > .sb-backend-section-header');
        const headerText = card?.textContent ?? '';
        const headerHidden = column.classList.contains('sb-prompt-hide-header');
        const revealHeader = !hideCollapsed && headerHidden && (headerMeasuredWidth !== width || headerMeasuredText !== headerText || !draft);
        const fits = !headerHidden && card && [...card.querySelectorAll('.sb-backend-title-row, .sb-editor-meta')].every(node => node.scrollWidth <= node.clientWidth + 1);
        const actionLayout = measureActions();
        if (collapsed !== nextCollapsed) closeOverlays();
        collapsed = nextCollapsed;
        if (root.dataset.collapsed !== String(collapsed)) root.dataset.collapsed = String(collapsed);
        if (root.style.getPropertyValue('--sb-prompt-list-width') !== `${nextListWidth}px`) root.style.setProperty('--sb-prompt-list-width', `${nextListWidth}px`);
        if (divider.getAttribute('aria-valuenow') !== String(Math.round(nextListWidth))) divider.setAttribute('aria-valuenow', String(Math.round(nextListWidth)));
        const listInert = collapsed && Boolean(draft);
        if (list.inert !== listInert) list.inert = listInert;
        if (column.classList.contains('sb-prompt-detail-open') !== Boolean(draft)) column.classList.toggle('sb-prompt-detail-open', Boolean(draft));
        const hideHeader = !revealHeader && Boolean(draft) && (collapsed || !fits);
        if (headerHidden !== hideHeader) column.classList.toggle('sb-prompt-hide-header', hideHeader);
        headerMeasuredWidth = width;
        headerMeasuredText = headerText;
        updateActions(actionLayout);
        // A previously collapsed header must become measurable before checking its overflow.
        if (revealHeader) scheduleLayout();
    }

    function scheduleSynchronize() {
        if (synchronizeFrame) return;
        synchronizeFrame = requestAnimationFrame(() => {
            synchronizeFrame = 0;
            synchronize();
        });
    }

    function synchronize() {
        cancelAnimationFrame(synchronizeFrame);
        synchronizeFrame = 0;
        if (!stylesReady || !promptManager?.serviceSettings) return;
        model ??= createPromptEditorModel(promptManager);
        const isChatCompletion = main_api === 'openai';
        if (!isChatCompletion && !document.getElementById('sysprompt_content')) return;
        const next = isChatCompletion ? model.snapshot() : model.snapshotTextCompletions();
        if (!next) return;
        state = next;
        const nextTokenizer = isChatCompletion ? JSON.stringify([getTokenizerModel(), state.scope]) : '';
        if (nextTokenizer !== tokenizerKey) {
            tokenizerKey = nextTokenizer;
            contentCounts.clear();
            contentRequests.clear();
            tokenRequest++;
            if (draft) scheduleTokens();
        }
        if (draft && draftScope !== state.scope && !dirty()) closeNow();
        if (!isChatCompletion) {
            tokenizerKey = '';
            contentCounts.clear();
            contentRequests.clear();
        }
        if (root.hidden) root.hidden = false;
        if (!column.classList.contains('sb-prompt-owned')) column.classList.add('sb-prompt-owned');
        if (draft && !dirty()) {
            const live = kind === 'prompt'
                ? promptFor(draft.identifier)
                : kind === 'text-completion' ? model.readTextCompletionEntry(draft.identifier) : { ...draft, content: model.readUtility(draft.identifier) };
            if (!live && !draft.runtime) closeNow();
            else if (live && JSON.stringify(live) !== baseline) {
                draft = structuredClone(live);
                baseline = JSON.stringify(draft);
                draftScope = state.scope;
                renderEditor();
            }
        }
        if (renderList()) scheduleLayout();
    }

    divider.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        sidebarWidth = Math.max(240, Math.min(420, listWidth() + (event.key === 'ArrowLeft' ? -10 : 10)));
        localStorage.setItem('sb-pm-list-width', String(sidebarWidth));
        layout();
    });
    divider.addEventListener('pointerdown', event => {
        if (transition) return;
        event.preventDefault();
        divider.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = listWidth();
        const move = moveEvent => {
            sidebarWidth = Math.max(240, Math.min(420, startWidth + moveEvent.clientX - startX));
            scheduleLayout();
        };
        const end = () => {
            divider.removeEventListener('pointermove', move);
            divider.removeEventListener('pointerup', end);
            divider.removeEventListener('pointercancel', end);
            localStorage.setItem('sb-pm-list-width', String(sidebarWidth));
        };
        divider.addEventListener('pointermove', move);
        divider.addEventListener('pointerup', end, { once: true });
        divider.addEventListener('pointercancel', end, { once: true });
    });
    editor.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); void closeEditor(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    });
    document.addEventListener('pointerdown', event => {
        if (overlay && !overlay.node.contains(event.target) && !overlay.trigger.contains(event.target)) closePopover();
    });
    document.addEventListener('change', async event => {
        if (replayingChange || !dirty() || !(event.target instanceof HTMLSelectElement)) return;
        const select = event.target;
        const isBackendSwitch = select.id === 'main_api';
        const tcPresetIndex = { sysprompt_select: 1, instruct_presets: 2, context_presets: 3 }[select.id];
        const isRelevantPreset = kind === 'text-completion' ? tcPresetIndex !== undefined : select.id === 'settings_preset_openai';
        if (!isBackendSwitch && !isRelevantPreset) return;
        event.stopImmediatePropagation();
        const nextValue = select.value;
        const scope = JSON.parse(draftScope);
        const previousValue = isBackendSwitch
            ? kind === 'text-completion' ? scope[0] : main_api
            : tcPresetIndex !== undefined ? scope[tcPresetIndex] : [...select.options].find(option => option.textContent === scope[2])?.value;
        select.value = previousValue;
        if (!(await allowLeave())) return;
        closeNow();
        select.value = nextValue;
        replayingChange = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        replayingChange = false;
    }, true);
    document.addEventListener('sb:shell-tab-activated', async event => {
        if (event.detail.tabId === 'editor') { synchronize(); return; }
        cancelNavigation();
        closeOverlays();
        if (!dirty()) return;
        if (!(await allowLeave())) {
            window.SillyBunnyShell.openTab('left', 'editor');
            if (mobile.matches) document.querySelector('button[data-sb-settings-tab="editor"]')?.click();
        } else closeNow();
    });
    document.addEventListener('change', event => {
        if (event.target instanceof HTMLSelectElement && event.target.matches('#sysprompt_select, #instruct_presets, #context_presets')) scheduleSynchronize();
    });
    window.addEventListener('beforeunload', event => {
        if (!dirty()) return;
        event.preventDefault();
        event.returnValue = '';
    });
    document.addEventListener('sb:prompt-manager-rendered', scheduleSynchronize);
    document.getElementById('main_api')?.addEventListener('change', scheduleSynchronize);
    eventSource.on(event_types.APP_READY, synchronize);
    const resizeObserver = new ResizeObserver(scheduleLayout);
    resizeObserver.observe(root);
    mobile.addEventListener('change', () => { cancelNavigation(); scheduleLayout(); });
    window.SillyBunnyAssets.loadStylesheetAsync('css/sillybunny-prompt-editor.css', { id: 'deferred-prompt-editor-css' })
        .then(() => { stylesReady = true; synchronize(); })
        .catch(error => toastr.error(error.message));
}
