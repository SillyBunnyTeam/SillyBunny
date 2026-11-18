import { t } from '../i18n.js';
import { openPicker } from './picker.js';
import { createSelectRow } from './select-row.js';

const attachments = new WeakMap();
const TAG_SELECTOR = '.rm_tag_filter .tag:not(.actionable)';
const STYLESHEET = { href: 'css/sillybunny-editor-shell.css?v=20261118zt', id: 'deferred-editor-shell-css' };

async function loadPickerStyles() {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!loader) return;
    let link = document.getElementById(STYLESHEET.id);
    try {
        const loading = loader(STYLESHEET.href, { id: STYLESHEET.id });
        link = document.getElementById(STYLESHEET.id);
        await loading;
    } catch (error) {
        if (link instanceof HTMLLinkElement && document.getElementById(STYLESHEET.id) === link) link.remove();
        throw error;
    }
}

/**
 * Attaches a searchable picker to the upstream tag filter transports without owning their state.
 * @param {HTMLElement} controls An upstream .rm_tag_controls element.
 * @param {{ title?: string }} [options]
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function attachTagFilterMenu(controls, { title = t`Show Tag List` } = {}) {
    if (!(controls instanceof HTMLElement)) throw new TypeError('Tag filter controls require an HTMLElement.');
    if (attachments.has(controls)) return attachments.get(controls);
    const filter = controls.querySelector('.rm_tag_filter');
    if (!filter) throw new Error('Tag filter list is missing.');
    const pickerTitle = title ?? t`Show Tag List`;
    const originalMark = controls.getAttribute('data-sb-tag-menu');
    // A popout may clone the generated button, but not its native listener or attachment.
    controls.querySelectorAll(':scope > .sb-tag-filter-menu-button').forEach(button => button.remove());
    controls.dataset.sbTagMenu = 'true';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-tag-filter-menu-button';
    button.title = t`Show Tag List`;
    button.setAttribute('aria-label', button.title);
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-tags';
    icon.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('span');
    badge.className = 'sb-tag-filter-menu-count';
    button.append(icon, badge);
    filter.after(button);
    let picker;
    let loading = false;
    let destroyed = false;
    const tags = () => [...controls.querySelectorAll(TAG_SELECTOR)];
    const liveTag = id => tags().find(tag => tag.id === id);
    const items = () => tags().map(tag => {
        const dot = document.createElement('span');
        dot.className = 'sb-tag-filter-menu-dot';
        dot.style.backgroundColor = tag.style.backgroundColor || 'var(--sb-muted-fg)';
        return { value: tag.id, label: tag.querySelector('.tag_name')?.textContent ?? '', icon: dot, muted: tag.classList.contains('tag-absent') };
    });

    function labelActions() {
        // Initial transports can render before this surface acquires its SillyBunny scope.
        for (const action of filter.querySelectorAll('.tag.actionable')) {
            const glyph = action.querySelector('.tag_name');
            const label = glyph?.getAttribute('title') ?? glyph?.getAttribute('data-sttt--title');
            if (label) action.setAttribute('aria-label', label);
            glyph?.setAttribute('aria-hidden', 'true');
        }
    }

    function refresh() {
        if (destroyed) return;
        labelActions();
        const currentTags = tags();
        const count = currentTags.filter(tag => tag.matches('.selected, .excluded')).length;
        badge.textContent = String(count);
        badge.hidden = !count;
        button.classList.toggle('is-active', count > 0);
        button.hidden = !currentTags.length;
        if (button.hidden || controls.closest('[data-selection-mode="true"]')) picker?.close();
        else picker?.refresh(items());
    }

    async function open() {
        if (loading || destroyed) return;
        loading = true;
        try {
            await loadPickerStyles();
            if (destroyed || !controls.isConnected || button.hidden || controls.closest('[data-selection-mode="true"]')) return;
            // The upstream filter prints 50 tags and an expander chip; the picker searches the chips, so it needs them all.
            const expander = filter.querySelector('.tag.placeholder-expander');
            if (expander) {
                expander.click();
                // The options below are read after the reprint, so the picker need not render them a second time for it.
                observer.takeRecords();
                labelActions();
            }
            const footer = [
                ['.clearAllFilters', t`Clear All Filters`, 'filter-circle-xmark'],
                ['.manageTags', t`Manage Tags`, 'tags'],
            ].filter(([selector]) => controls.querySelector(selector)).map(([selector, label, glyph]) => ({
                label, icon: `fa-solid fa-${glyph}`, onSelect: () => controls.querySelector(selector)?.click(),
            }));
            picker = openPicker({
                trigger: button, title: pickerTitle, multiple: true, items: items(), footer,
                // The group editor's member lists are too short to hold the menu; bound it to the sheet.
                bounds: controls.closest('.sb-character-list, #groupMemberListPopout, .sb-editor-sheet'),
                getItemState: id => {
                    const tag = liveTag(id);
                    if (tag?.classList.contains('selected')) return 'selected';
                    return tag?.classList.contains('excluded') ? 'excluded' : null;
                },
                onSelect: id => liveTag(id)?.click(),
            });
        } catch (error) {
            globalThis.toastr?.error(error?.message ?? String(error));
        } finally {
            loading = false;
        }
    }

    button.addEventListener('click', open);
    const observer = new MutationObserver(refresh);
    observer.observe(filter, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    const handle = { refresh, destroy() {
        if (destroyed) return;
        destroyed = true;
        observer.disconnect();
        picker?.close();
        button.removeEventListener('click', open);
        button.remove();
        if (originalMark === null) controls.removeAttribute('data-sb-tag-menu');
        else controls.setAttribute('data-sb-tag-menu', originalMark);
        attachments.delete(controls);
    } };
    attachments.set(controls, handle);
    refresh();
    return handle;
}

/**
 * Draws an editor's tags as one row that opens the shared picker, as its Folder row does: `createSelectRow` over a select of every
 * tag. The row names the applied tags, the picker ticks them and lists them first, and a search that names no tag offers to
 * create it. Upstream stays in charge of the tags: they are added through the add field's own autocomplete handler and removed
 * through the chips' Remove buttons, and upstream keeps printing the chips into `list`, which is the source of truth (a character
 * that is still being created has no tag map entry). The add field's row and the chips stay in the page, hidden.
 * @param {object} options
 * @param {HTMLInputElement|null} options.input  Upstream's add field, with its jQuery UI autocomplete.
 * @param {HTMLElement|null} options.list  The chips upstream prints for the entity.
 * @param {HTMLElement|null} [options.manage]  Upstream's button that opens the Tag Manager.
 * @param {string} options.field
 * @param {Function} options.jquery  jQuery, to reach the add field's autocomplete.
 * @returns {{ row: HTMLElement, destroy: () => void }|null}
 */
export function adoptTagField({ input, list, manage = null, field, jquery }) {
    if (!(input instanceof HTMLInputElement) || !(list instanceof HTMLElement) || list.dataset.sbTagField) return null;
    list.dataset.sbTagField = 'true';
    // Upstream prints 50 chips and an expander chip unless the list has this class; the row reads every chip.
    list.classList.add('tags-expanded');
    // The context getter reads bindings that the app initialises late, so it throws while the editors mount at start-up.
    const allTags = () => {
        try {
            return globalThis.SillyTavern?.getContext?.().tags ?? [];
        } catch {
            return [];
        }
    };
    let byId = new Map();
    const applied = () => [...list.querySelectorAll(':scope > .tag:not(.placeholder-expander, [data-sb-removing="true"])')].map(chip => chip.id);
    const select = document.createElement('select');
    select.multiple = true;
    select.id = `${input.id}_choices`;
    select.setAttribute('aria-label', t`Tags`);

    // The applied tags lead, in the chips' order; the order is kept while the picker is open, so a ticked tag does not jump.
    const fill = ({ reorder = false } = {}) => {
        const ids = applied();
        const tags = allTags();
        byId = new Map(tags.map(tag => [tag.id, tag]));
        if (reorder || select.options.length !== tags.length) {
            const rest = tags.filter(tag => !ids.includes(tag.id)).sort((a, b) => a.name.localeCompare(b.name));
            select.replaceChildren(...[...ids.map(id => byId.get(id)).filter(Boolean), ...rest].map(tag => new Option(tag.name, tag.id)));
        }
        for (const option of select.options) option.selected = ids.includes(option.value);
    };

    const add = name => {
        const handler = jquery(input).autocomplete('option', 'select');
        if (typeof handler !== 'function') return;
        handler({ target: input }, { item: { value: name } });
        // Upstream clears the field and searches again, which would open its own menu at the hidden field.
        jquery(input).autocomplete('close');
    };
    const remove = id => [...list.children].find(chip => chip.id === id)?.querySelector('.tag_remove')?.click();
    const colorOf = id => byId.get(id)?.color || '';

    const row = createSelectRow({
        select,
        label: t`Tags`,
        // The names of the applied tags are the row's subtitle, dimmed under its title, and the trigger holds their count.
        subtitle: ' ',
        summarize: items => (items.length ? String(items.length) : ''),
        field,
        searchLabel: t`Search`,
        emptyText: t`No Results`,
        noneLabel: t`None`,
        mapItem: item => {
            const dot = document.createElement('span');
            dot.className = 'sb-tag-dot';
            const color = colorOf(item.value);
            if (color) dot.style.setProperty('--sb-tag-color', color);
            return { ...item, icon: dot };
        },
        onPick: next => {
            const ids = applied();
            for (const id of next.filter(id => !ids.includes(id))) {
                const name = byId.get(id)?.name;
                if (name) add(name);
            }
            for (const id of ids.filter(id => !next.includes(id))) remove(id);
        },
        create: { onCreate: add, label: text => t`Create Tag ${text}` },
        footer: manage ? [{ label: t`Manage Tags`, icon: 'fa-solid fa-tags', onSelect: () => manage.click() }] : [],
    });
    row.row.classList.add('sb-tag-field');
    const names = row.row.querySelector('.ds-row-subtitle');
    const showNames = () => {
        const text = applied().map(id => byId.get(id)?.name).filter(Boolean).join(', ');
        names.textContent = text;
        names.hidden = !text;
    };
    fill({ reorder: true });
    showNames();
    // Reorder before the row's own handlers open the picker.
    row.row.addEventListener('click', () => fill({ reorder: true }), true);
    const observer = new MutationObserver(() => {
        fill();
        showNames();
    });
    observer.observe(list, { childList: true, attributes: true, attributeFilter: ['data-sb-removing'], subtree: true });

    const entry = input.closest('.ds-row') ?? input.parentElement;
    list.before(row.row);
    entry.hidden = true;
    list.hidden = true;
    return {
        row: row.row,
        destroy() {
            observer.disconnect();
            row.destroy();
        },
    };
}
