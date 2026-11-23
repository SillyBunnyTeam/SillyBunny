/**
 * SillyBunny subpage descriptors.
 *
 * `sillybunny-settings-subpage.js` is the stack; this is the part that knows what each panel's rows
 * are. Each panel it covers, Extensions and Prompting, is described here as a list of rows and the
 * section each row opens, because both are built out of accordions. Agents
 * is presented as a dashboard by its own extension and keeps that layout.
 *
 * Connections is not here. Its backend picker is the axis every one of its settings hangs off, so
 * behind a row it would make the only way to change backend an action that writes global API state, and the
 * page it needs on screen is the picker itself. It is built by hand instead, in
 * `sillybunny-connections-panel.js`.
 *
 * The descriptions are the copy of the page. SillyBunny can describe only the extensions it ships,
 * so the Extensions list is split into System Extensions, which have a description, and
 * User-installed Extensions, which show their name alone.
 */

import { createButtonRow, createEntryRow, createPrefGroup, createSwitchRow, moveCaption } from './sillybunny-editor/rows.js';

/**
 * Descriptions of the extensions SillyBunny ships (built-in, core and bundled), keyed by the
 * container each one mounts its settings in. A container that is not listed here belongs to an
 * extension the user installed.
 */
const SB_SYSTEM_EXTENSION_DESCRIPTIONS = new Map([
    ['sbdbg-settings', 'Inspect console logs, network requests, and page elements, and create diagnostic reports.'],
    ['bpt-settings', 'Organize prompts into collapsible sections, search them, and use video backgrounds.'],
    ['expressions_container', 'Show character sprites that change to match the emotions in their messages'],
    ['ChatCompletionTabs-drawer', 'Adds Parameters and Prompts tabs to the older Chat Completion layout.'],
    ['ChatCompletionTabs-container', 'Adds Parameters and Prompts tabs to the older Chat Completion layout.'],
    ['translation_container', 'Translate chat messages manually or automatically using your chosen translation service'],
    ['extension_settings_guided-generations', 'Guide replies, rewrites, and impersonation with instructions from the message box.'],
    ['caption_container', 'Generate text descriptions for images in your chats'],
    ['sd_container', 'Generate character portraits, scenes, and backgrounds with your chosen image service.'],
    ['extension_settings_in_chat_agents_pathfinder', 'Let an AI agent search and update lorebooks and summarize your chat.'],
    ['qig-settings', 'Generate images from prompts or chat scenes, with style presets and a gallery.'],
    ['qr_container', 'Create buttons that insert or send saved text, or run commands'],
    ['regex_container', 'Find and replace text in messages and prompts using regular expressions.'],
    ['summarize_container', 'Create and update a chat summary to use in the AI\'s prompt'],
    ['tts_container', 'Read chat messages aloud using your chosen voices and speech provider.'],
    ['vectors_container', 'Find relevant messages, file passages, and lorebook entries for the AI\'s prompt.'],
]);

/**
 * The Font Awesome (Free, solid) glyph that leads the row of each extension SillyBunny ships, by container. An extension
 * with no entry here is listed without an icon, and a user-installed extension never has one.
 */
const SB_SYSTEM_EXTENSION_ICONS = new Map([
    ['sbdbg-settings', 'fa-bug'],
    ['bpt-settings', 'fa-layer-group'],
    ['expressions_container', 'fa-face-smile'],
    ['ChatCompletionTabs-drawer', 'fa-window-restore'],
    ['ChatCompletionTabs-container', 'fa-window-restore'],
    ['translation_container', 'fa-language'],
    ['extension_settings_guided-generations', 'fa-compass'],
    ['caption_container', 'fa-closed-captioning'],
    ['sd_container', 'fa-image'],
    ['extension_settings_in_chat_agents_pathfinder', 'fa-book-open'],
    ['qig-settings', 'fa-images'],
    ['qr_container', 'fa-bolt'],
    ['regex_container', 'fa-asterisk'],
    ['summarize_container', 'fa-file-lines'],
    ['tts_container', 'fa-volume-high'],
    ['vectors_container', 'fa-magnifying-glass'],
]);

/**
 * The containers of the extensions SillyBunny ships as its own, whose settings pages get the shared rows.
 *
 * It is a list of ids and not "everything with a description": Bunny Preset Tools and Chat Completion Tabs
 * ship in the `third-party` folder and Quick Image Gen is vendored, so all three keep the markup they were
 * authored with, and an extension the user installs is never in it. Pathfinder (`in-chat-agents`) draws
 * its whole page itself, with mode cards, numbered steps and its own stylesheet, so it is not listed.
 */
const SB_BUILT_IN_EXTENSION_CONTAINERS = new Set([
    'sbdbg-settings',
    'expressions_container',
    'translation_container',
    'extension_settings_guided-generations',
    'caption_container',
    'sd_container',
    'qr_container',
    'regex_container',
    'summarize_container',
    'tts_container',
    'vectors_container',
]);

/**
 * @param {string} containerId
 * @returns {boolean}
 */
export function isBuiltInExtensionContainer(containerId) {
    return SB_BUILT_IN_EXTENSION_CONTAINERS.has(containerId);
}

/** The Extensions list's groups, in the order they are shown. */
const SB_EXTENSION_GROUPS = Object.freeze({
    system: Object.freeze({ id: 'system', title: 'System Extensions' }),
    user: Object.freeze({ id: 'user', title: 'User-Installed Extensions' }),
});

/**
 * Builds the row list for the Extensions panel.
 *
 * The panel hands each extension an `extension_container` and lets it build whatever it likes
 * inside. The list is therefore discovered rather than authored: one row per container that holds
 * something, labelled from the drawer toggle the extension itself built. Containers mount after the
 * panel is built and some mount long after, so the caller refreshes this list on a mutation.
 *
 * @param {HTMLElement} panel
 * @returns {object|null}
 */
export function buildExtensionsSubpage(panel) {
    const body = panel.querySelector('#rm_extensions_block .extensions_block');
    if (!(body instanceof HTMLElement)) {
        return null;
    }

    return {
        rows: collectExtensionRows(body),
        observe: body,
        // SillyBunny: always-visible section placed above the row list, not treated as a row.
        pinned: body.querySelector('#assets_container') ?? null,
    };
}

const textOf = node => node?.textContent.replace(/\s+/g, ' ').trim() ?? '';

/**
 * Turns one of the page's upstream action buttons into a button row that opens a window. The button keeps its node, so the
 * handlers and the `disabled` and `warning` classes that `script.js` and `extensions.js` put on it by id still reach it.
 *
 * @param {HTMLElement} button
 * @param {string} field
 * @returns {object}
 */
function adoptActionRow(button, field) {
    const label = textOf(button.querySelector('span') ?? button);
    const labelKey = button.querySelector('[data-i18n]')?.dataset.i18n;
    const ownKey = button.dataset.i18n;
    const row = createButtonRow({ label, field, arrow: true, button });
    // The row moves the button's own translation key to its label, which only fits a key that names text. A key that
    // names the tooltip (`[title]…`) belongs to the button, and the label takes the key of the caption it replaced.
    const caption = row.row.querySelector('.ds-row-label');
    if (labelKey && !caption.dataset.i18n) caption.dataset.i18n = labelKey;
    if (ownKey?.startsWith('[')) button.dataset.i18n = ownKey;
    return row;
}

/**
 * The switch row for the update notice. The switch input is the upstream control and keeps its id; the old label is
 * dropped, and its title and caption move into the row with their translation keys.
 *
 * @param {HTMLInputElement} input
 * @returns {object}
 */
function adoptNotifyRow(input) {
    const oldLabel = input.closest('label');
    const title = oldLabel?.querySelector('.ds-row-label, span');
    const caption = oldLabel?.querySelector('.ds-row-subtitle, small');
    const row = createSwitchRow({ label: textOf(title), subtitle: textOf(caption) || undefined, field: 'notify-updates', input });
    moveCaption(row.row.querySelector('.ds-row-label'), title);
    const subtitle = row.row.querySelector('.ds-row-subtitle');
    if (subtitle && caption) moveCaption(subtitle, caption);
    oldLabel?.remove();
    return row;
}

/**
 * The group of the page's own actions: the two windows it opens and the update notice. It shows no heading; its
 * accessible name is the heading that the upstream block gave these three controls.
 *
 * @param {HTMLElement} panel
 * @returns {HTMLElement|null}
 */
function presentExtensionActions(panel) {
    const rows = [
        ['#extensions_details', 'manage-extensions'],
        ['#third_party_extension_button', 'install-extension'],
    ].flatMap(([selector, field]) => {
        const button = panel.querySelector(selector);
        return button instanceof HTMLElement ? [adoptActionRow(button, field)] : [];
    });
    const notify = panel.querySelector('#extensions_notify_updates');
    if (notify instanceof HTMLInputElement) rows.push(adoptNotifyRow(notify));
    if (!rows.length) return null;

    const source = panel.querySelector('.extensions_block > .alignitemscenter > h3');
    // The group has no title, as an AdwPreferencesGroup may have none: the box takes its name from the upstream heading instead.
    const group = createPrefGroup({ field: 'extension-actions' });
    group.section.dataset.sbPresentation = 'manual';
    group.group.setAttribute('aria-label', textOf(source) || 'Extensions');
    group.group.dataset.i18n = `[aria-label]${source?.dataset.i18n || 'Extensions'}`;
    group.append(...rows);
    return group.section;
}

/**
 * Presents the Download Extensions & Assets section as a group: the drawer's title is the heading, its hint the
 * description, and the asset list address a floating entry row with the connect button at its end. What the section
 * shows once a list is loaded (the filters and the catalogue) is the assets extension's own and stays as it is.
 *
 * @param {HTMLElement} ui `#assets_ui`, as the assets extension mounts it
 * @returns {boolean} whether the section was presented
 */
function presentAssets(ui) {
    if (ui.dataset.sbPresentation === 'manual') {
        return false;
    }
    const drawer = ui.querySelector(':scope > .inline-drawer');
    const title = drawer?.querySelector(':scope > .inline-drawer-toggle > b');
    const content = drawer?.querySelector(':scope > .inline-drawer-content');
    const urlBlock = content?.querySelector('.assets-url-block');
    const input = urlBlock?.querySelector('#assets-json-url-field');
    if (!title || !(content instanceof HTMLElement) || !(input instanceof HTMLInputElement)) {
        return false;
    }

    const hint = content.querySelector(':scope > small');
    const group = createPrefGroup({ title: textOf(title), subtitle: textOf(hint) || undefined, field: 'assets' });
    moveCaption(group.section.querySelector('.ds-pref-group-heading'), title);
    if (hint) moveCaption(group.section.querySelector('.ds-pref-group-subtitle'), hint);

    const label = urlBlock.querySelector('label[for="assets-json-url-field"]');
    const caption = urlBlock.querySelector(':scope > small');
    const connect = urlBlock.querySelector('#assets-connect-button');
    if (connect instanceof HTMLElement) {
        // The connect icon is the upstream control and a plain icon element: it needs a role, a tab stop and the keys of a button.
        connect.setAttribute('role', 'button');
        connect.tabIndex = 0;
        connect.addEventListener('keydown', event => {
            if (event.target === connect && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                connect.click();
            }
        });
    }
    const entry = createEntryRow({
        label: textOf(label) || 'Assets URL',
        subtitle: textOf(caption) || undefined,
        field: 'assets-url',
        input,
        floating: true,
        suffix: connect instanceof HTMLElement ? [connect] : undefined,
    });
    if (label) moveCaption(entry.row.querySelector('.ds-row-entry__title'), label);
    const entryCaption = entry.row.querySelector('.ds-row-entry__caption');
    if (entryCaption && caption) {
        const tooltip = caption.title;
        moveCaption(entryCaption, caption);
        entryCaption.title = tooltip;
    }
    group.append(entry);

    ui.classList.add('sb-editor-section', 'sb-assets-section');
    ui.dataset.sbPresentation = 'manual';
    ui.replaceChildren(...group.section.children);
    ui.append(...['#assets_filters', '#assets_menu'].flatMap(selector => content.querySelector(`:scope > ${selector}`) ?? []));
    return true;
}

/**
 * Builds the groups that lead the Extensions page, ahead of the list of extensions: the page's actions, and the
 * Download Extensions & Assets section that the assets extension mounts into `pinned`, which can be after this runs.
 *
 * @param {HTMLElement} panel
 * @param {HTMLElement|null} pinned `#assets_container`
 * @param {{onPresented?: () => void}} [hooks] `onPresented` runs once the assets section has been presented
 * @returns {{sections: HTMLElement[], disconnect: () => void}}
 */
export function buildExtensionsLead(panel, pinned, { onPresented } = {}) {
    const sections = [];
    const actions = presentExtensionActions(panel);
    if (actions) {
        sections.push(actions);
    }

    let disconnect = () => {};
    if (pinned instanceof HTMLElement) {
        sections.push(pinned);
        const present = () => {
            const ui = pinned.querySelector(':scope > #assets_ui');
            if (!(ui instanceof HTMLElement) || !presentAssets(ui)) {
                return false;
            }
            onPresented?.();
            return true;
        };
        if (!present()) {
            const observer = new MutationObserver(() => {
                if (present()) {
                    observer.disconnect();
                }
            });
            observer.observe(pinned, { childList: true });
            disconnect = () => observer.disconnect();
        }
    }

    return { sections, disconnect };
}

/**
 * Collects one row per non-empty extension container, System Extensions first.
 *
 * Extensions build their own title, and they do it in two different shapes: most wrap their settings
 * in a drawer the container holds, while a few put the drawer class on the container itself. Both
 * have to be read, because the container's whole text is not a label: it is the label plus every
 * setting inside it.
 *
 * @param {HTMLElement} body
 * @returns {object[]}
 */
function collectExtensionRows(body) {
    const containers = body.querySelectorAll('#extensions_settings > *, #extensions_settings2 > *');
    const rows = [];

    for (const container of containers) {
        if (!(container instanceof HTMLElement) || isContainerEmpty(container)) {
            continue;
        }

        // SillyBunny: assets_container is pinned above the row list; skip it as a row.
        if (container.id === 'assets_container') {
            continue;
        }

        const label = readExtensionLabel(container);
        if (!label) {
            continue;
        }

        const description = SB_SYSTEM_EXTENSION_DESCRIPTIONS.get(container.id);
        rows.push({
            id: container.id || `extension-${rows.length}`,
            label,
            description,
            descriptionKey: description,
            group: description ? SB_EXTENSION_GROUPS.system : SB_EXTENSION_GROUPS.user,
            icon: description ? SB_SYSTEM_EXTENSION_ICONS.get(container.id) : undefined,
            builtIn: isBuiltInExtensionContainer(container.id),
            source: () => container,
            isAvailable: () => !isContainerEmpty(container),
        });
    }

    return Object.values(SB_EXTENSION_GROUPS).flatMap(group => rows.filter(row => row.group === group));
}

/**
 * Reads the title an extension gave its own container.
 *
 * The title is the text of the drawer's toggle, and specifically of the element the extension used
 * to say its name. The rest of the toggle is icon glyphs and, in some cases, a help marker the
 * extension appends. Falls back to the toggle's own text when the extension used none of the usual
 * elements, and returns an empty string rather than a paragraph when there is no drawer at all.
 *
 * @param {HTMLElement} container
 * @returns {string}
 */
function readExtensionLabel(container) {
    const drawer = container.classList.contains('inline-drawer')
        ? container
        : container.querySelector('.inline-drawer');
    const toggle = drawer?.querySelector(':scope > .inline-drawer-toggle, :scope > .inline-drawer-header');
    if (!(toggle instanceof HTMLElement)) {
        return '';
    }

    const title = toggle.querySelector(':scope > b, :scope > h3, :scope > h4, :scope > span');
    const source = title instanceof HTMLElement ? title : toggle;

    return readOwnText(source);
}

/**
 * The text an element shows under its own name.
 *
 * A title often carries a help marker (an anchor wrapping a `?` glyph) that documents the card
 * rather than naming it. Reading it into the label puts a stray character after the name that the
 * page then repeats in every list row, so links are left out.
 *
 * @param {HTMLElement} element
 * @returns {string}
 */
function readOwnText(element) {
    let text = '';
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue ?? '';
            continue;
        }
        if (node instanceof HTMLElement && !node.closest('a')) {
            text += node.textContent ?? '';
        }
    }

    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Whether an extension container holds nothing worth a row.
 *
 * `:empty` is not enough: several containers hold whitespace text nodes, and the browser's own
 * `:empty` rule in `extensions-panel.css` only catches the ones with no children at all.
 *
 * @param {HTMLElement} container
 * @returns {boolean}
 */
function isContainerEmpty(container) {
    if (container.childElementCount === 0) {
        return true;
    }
    return !/\S/.test(container.textContent ?? '')
        && container.querySelector('input, select, textarea, img, canvas, button') === null;
}

/**
 * The descriptor lookup by tab id.
 *
 * @type {Record<string, (panel: HTMLElement) => (object|null)>}
 */
export const SB_SUBPAGE_BUILDERS = Object.freeze({
    extensions: buildExtensionsSubpage,
});
