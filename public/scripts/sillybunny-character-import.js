import { characters, default_avatar, getThumbnailUrl, runCharacterImport, selectCharacterById } from '../script.js';
import { extensionNames, extension_settings } from './extensions.js';
import { eventSource, event_types } from './events.js';
import { t } from './i18n.js';
import { renderTemplateAsync } from './templates.js';
import { createButtonRow, createPrefGroup, createRow, createTextAreaField } from './sillybunny-editor/rows.js';
import { createEntityRow } from './sillybunny-editor/entity-row.js';
import { createStatusPage } from './sillybunny-editor/status-page.js';
import { objectNavigation } from './sillybunny-editor/object-navigation.js';
import { confirmActiveEditorLeave } from './sillybunny-editor/navigation.js';
import { rememberOpenedEntity } from './sillybunny-auto-load.js';

const mounted = new WeakMap();

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function button(label, action, id = '') {
    const control = element('button', 'menu_button', label);
    control.type = 'button';
    control.id = id;
    control.addEventListener('click', () => {
        Promise.resolve().then(action).catch(error => globalThis.toastr?.error(error.message));
    });
    return control;
}

function group({ label, field, subtitle, rows = [] }) {
    const { section, group: box } = createPrefGroup({ title: label, subtitle, field: `import-${field}`, rows });
    section.classList.add('sb-import-section');
    return { section, group: box, heading: section.querySelector('.ds-pref-group-heading'), subtitle: section.querySelector('.ds-pref-group-subtitle') };
}

function resultButton(label, glyph, action) {
    const control = button('', action);
    control.removeAttribute('id');
    control.classList.add('sb-import-result-action');
    control.title = label;
    control.setAttribute('aria-label', label);
    const icon = element('i', `fa-solid fa-${glyph}`);
    icon.setAttribute('aria-hidden', 'true');
    control.append(icon, element('span', 'sb-import-result-action-label', label));
    return control;
}

/** Loads retryable deferred styles before the Import surface is revealed. @param {{href: string, id: string}[]} stylesheets */
export async function loadCharacterImportStyles(stylesheets) {
    const loader = globalThis.SillyBunnyAssets?.loadStylesheetAsync;
    if (!loader) throw new Error('Deferred stylesheet loader is unavailable');
    await Promise.all(stylesheets.map(async ({ href, id }) => {
        let link;
        try {
            const loading = loader(href, { id });
            link = document.getElementById(id);
            await loading;
        } catch (error) {
            if (link instanceof HTMLLinkElement && document.getElementById(id) === link) link.remove();
            throw error;
        }
    }));
}

/**
 * Mounts the Import tab without changing the hidden upstream import transports.
 * @param {HTMLElement} host
 * @returns {{run: (input: object) => Promise<void>, refreshLibrary: () => void, prepareReveal: () => void, ready: Promise<void>}}
 */
export function mountCharacterImport(host) {
    if (!(host instanceof HTMLElement)) throw new TypeError('Import requires an HTMLElement.');
    if (mounted.has(host)) {
        mounted.get(host).refreshLibrary();
        return mounted.get(host);
    }
    const content = host.querySelector('#sb_character_import_content');
    if (!content) throw new Error('Import content host is missing.');
    let busy = false;
    let returnFocus = null;
    const hostListeners = new AbortController();
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = '.png,.json,.yaml,.yml,.charx,.byaf';
    picker.id = 'sb_character_import_files';
    picker.hidden = true;
    // The row is the drop area and the way to browse: a file dragged anywhere over the panel lands on it.
    const drop = createButtonRow({
        label: t`Import Character from File`, icon: 'file-import', field: 'file-drop', id: 'sb_character_import_drop',
        onActivate: () => { if (!busy) picker.click(); },
    });
    drop.row.classList.add('sb-import-drop');
    const zone = drop.row;
    const { section: fileSection } = group({
        label: t`Import from file`, field: 'file', rows: [drop],
        subtitle: `${t`Drop the associated character file here, or click to browse for it.`} ${t`Upload PNG, JSON, YAML, CHARX, or BYAF character files.`}`,
    });
    fileSection.append(picker);
    picker.addEventListener('change', () => {
        const files = [...picker.files];
        picker.value = '';
        if (files.length) void run({ files });
    });
    // Stop at the panel, not body: its upstream drop listener must never see these files twice.
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
        host.addEventListener(type, event => {
            event.preventDefault();
            event.stopPropagation();
            if (type === 'dragleave' && host.contains(event.relatedTarget)) return;
            zone.classList.toggle('is-dragover', type === 'dragenter' || type === 'dragover');
            if (type !== 'drop' || busy) return;
            const files = [...(event.dataTransfer?.files ?? [])];
            if (files.length) void run({ files });
            else {
                const urls = (event.dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/).filter(url => url && !url.startsWith('#'));
                if (urls.length) void run({ urls });
            }
        }, { signal: hostListeners.signal });
    }

    const entry = createTextAreaField({
        label: t`Enter the URL of the content to import`, subtitle: t`Write each URL or ID into a new line.`,
        field: 'urls', id: 'sb_character_import_urls', rows: 4, expand: false,
    });
    const submit = createButtonRow({
        label: t`Import`, icon: 'cloud-arrow-down', field: 'url-action', id: 'sb_character_import_url_action',
        onActivate: () => {
            const urls = entry.getValue().split(/\r?\n/).map(url => url.trim()).filter(Boolean);
            if (urls.length) return run({ urls });
        },
    });
    // The providers are a description of the group, filled in once the template that names them has loaded.
    const { section: urlSection, subtitle: sources } = group({ label: t`Import from URL`, field: 'url', rows: [entry, submit], subtitle: '\u00a0' });
    sources.classList.add('sb-import-sources');
    sources.replaceChildren();

    const libraryGroup = createPrefGroup({
        field: 'import-library', id: 'sb_character_import_library',
        rows: [createRow({
            label: t`Browse Characters`, field: 'character-library', activatable: true,
            onActivate: () => { void eventSource.emit(event_types.OPEN_CHARACTER_LIBRARY, false); },
        })],
    });
    // A group without a heading names itself for assistive technology.
    libraryGroup.group.setAttribute('aria-label', t`Browse Characters`);
    const library = libraryGroup.section;

    const resultsGroup = group({ label: t`Results.`, field: 'results', subtitle: '\u00a0' });
    const resultsSection = resultsGroup.section;
    resultsSection.id = 'sb_character_import_results';
    resultsSection.hidden = true;
    const summary = resultsGroup.subtitle;
    summary.classList.add('sb-import-summary');
    summary.setAttribute('role', 'status');
    summary.setAttribute('aria-live', 'polite');
    summary.textContent = '';
    const results = element('div', 'ds-entity-list');
    results.setAttribute('role', 'list');
    resultsGroup.group.append(results);
    content.replaceChildren(fileSection, urlSection, library, resultsSection);

    function refreshLibrary() {
        library.hidden = !extensionNames.includes('assets') || extension_settings.disabledExtensions.includes('assets');
    }

    function renderResult(result, index) {
        const actions = [];
        if (result.ok && result.kind === 'character') {
            actions.push(resultButton(t`Chat`, 'comment', async () => {
                if (!await confirmActiveEditorLeave()) return;
                const id = characters.findIndex(character => character.avatar === result.id);
                if (id < 0) return;
                if (await selectCharacterById(id, { switchMenu: false })) rememberOpenedEntity('character', result.id);
            }));
            actions.push(resultButton(t`Edit`, 'pencil', () => {
                returnFocus = `import-result:${index}`;
                return objectNavigation.navigate({ kind: 'character-editor', id: result.id, via: 'import' }, { from: { kind: 'import' } });
            }));
        } else if (result.ok && result.kind === 'lorebook') {
            actions.push(resultButton(t`World Info`, 'book-atlas', () => objectNavigation.navigate({ kind: 'world-info', id: result.id, via: 'import' }, { from: { kind: 'import' } })));
        }
        const status = element('span', 'sb-import-result-status');
        const glyph = element('i', `fa-solid fa-${result.ok ? 'circle-check' : 'triangle-exclamation'}`);
        glyph.setAttribute('aria-hidden', 'true');
        const message = result.ok ? t`Imported!` : result.error;
        status.append(glyph, document.createTextNode(message));
        const { row, slots } = createEntityRow({
            key: `import-result:${index}`, label: result.name, subtitle: status,
            avatar: result.ok && result.kind === 'character' ? { src: getThumbnailUrl('avatar', result.id), alt: '' } : null,
            suffix: actions,
        });
        slots.img?.addEventListener('error', () => { slots.img.src = default_avatar; }, { once: true });
        row.dataset.importStatus = result.ok ? 'success' : 'error';
        row.dataset.importKind = result.kind;
        return row;
    }

    async function run(input) {
        if (busy) return;
        busy = true;
        resultsSection.hidden = false;
        resultsSection.dataset.state = 'loading';
        content.setAttribute('aria-busy', 'true');
        drop.setDisabled(true);
        submit.setDisabled(true);
        picker.disabled = true;
        // HUMAN: replace — loading title that names what loads, in header capitalisation and without an ellipsis.
        results.replaceChildren(createStatusPage({ state: 'loading', title: t`Loading...` }).element);
        summary.textContent = '';
        try {
            const items = await runCharacterImport({ ...input, policy: 'stay' });
            const failures = items.filter(item => !item.ok).length;
            resultsSection.dataset.state = failures ? failures === items.length ? 'error' : 'partial' : 'success';
            summary.textContent = `${items.length - failures} / ${items.length}`;
            results.replaceChildren(...items.map(renderResult));
        } catch (error) {
            resultsSection.dataset.state = 'error';
            results.replaceChildren(createStatusPage({ state: 'error', title: t`Error`, description: String(error.message), compact: true }).element);
        } finally {
            busy = false;
            content.setAttribute('aria-busy', 'false');
            drop.setDisabled(false);
            submit.setDisabled(false);
            picker.disabled = false;
        }
    }

    const scroller = () => host.closest('.sb-shell-panel-scroller') ?? host.closest('.scrollableInner');
    objectNavigation.register('import', {
        async open(_target, { restore, isCurrent }) {
            if (!isCurrent()) return false;
            await globalThis.SillyBunnyShell.openTab('characters', 'import');
            if (!isCurrent()) return false;
            // Let shell visibility/layout settle before restoring the actual panel scroller.
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (!isCurrent()) return false;
            if (scroller() && restore) scroller().scrollTop = restore.scrollTop;
            if (returnFocus) results.querySelector(`[data-sb-list-key="${returnFocus}"] button:last-child`)?.focus({ preventScroll: true });
            return true;
        },
        captureState: () => ({ scrollTop: scroller()?.scrollTop ?? 0 }),
    });
    const controller = { run, refreshLibrary, prepareReveal: refreshLibrary, ready: null };
    mounted.set(host, controller);
    refreshLibrary();
    // Reuse upstream provider labels, omitting examples to keep this a subtitle rather than another popup.
    controller.ready = renderTemplateAsync('importCharacters').then(html => {
        const template = document.createElement('template');
        template.innerHTML = html;
        const list = template.content.querySelector('.sources_list');
        if (!list) return;
        sources.append(list.firstElementChild.cloneNode(true), document.createTextNode(' '));
        for (const [index, item] of [...list.querySelectorAll('li')].entries()) {
            if (index) sources.append(document.createTextNode('; '));
            for (const node of item.childNodes) {
                if (node.nodeName === 'BR') break;
                sources.append(node.cloneNode(true));
            }
        }
        const botbooru = element('span', 'sb-import-source-botbooru', t`BotBooru`);
        sources.append(document.createTextNode('; '), botbooru);
    }).then(() => {
        content.hidden = false;
        host.dataset.mounted = 'true';
    }).catch(error => {
        hostListeners.abort();
        mounted.delete(host);
        throw error;
    });
    controller.ready.catch(error => globalThis.toastr?.error(error.message));
    return controller;
}
