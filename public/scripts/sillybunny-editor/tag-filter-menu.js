import { t } from '../i18n.js';
import { openPicker } from './picker.js';

const attachments = new WeakMap();
const TAG_SELECTOR = '.rm_tag_filter .tag:not(.actionable)';
const STYLESHEET = { href: 'css/sillybunny-editor-shell.css?v=20261018b', id: 'deferred-editor-shell-css' };

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

    function refresh() {
        if (destroyed) return;
        // Initial transports can render before this surface acquires its SillyBunny scope.
        for (const action of filter.querySelectorAll('.tag.actionable')) {
            const glyph = action.querySelector('.tag_name');
            const label = glyph?.getAttribute('title') ?? glyph?.getAttribute('data-sttt--title');
            if (label) action.setAttribute('aria-label', label);
            glyph?.setAttribute('aria-hidden', 'true');
        }
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
            const footer = [
                ['.clearAllFilters', t`Clear all filters`, 'filter-circle-xmark'],
                ['.manageTags', t`Manage tags`, 'tags'],
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
