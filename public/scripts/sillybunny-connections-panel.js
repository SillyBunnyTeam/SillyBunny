/**
 * SillyBunny Connections panel (feat/v1.9.0-ui-overhaul).
 *
 * The Connections tab is where a user picks a backend and configures it, so every control that
 * decides *what* is being configured belongs on one page, always visible:
 *
 *     heading
 *     ├── Connection Profile   which saved configuration is loaded
 *     ├── Backend              Chat Completion | Text Completion | Other Backends
 *     ├── Source               the provider within that backend (Chat and Text only)
 *     └── <that provider's own settings, moved here from upstream's markup, with its own
 *          connect / authorize / test row pinned above them>
 *
 * It is built by hand rather than by the subpage stack the Extensions and Prompting tabs still use.
 * The stack presents a panel as a list of rows that slide a detail page over the list, which is the
 * right shape for a panel whose sections are peers -- but it is the wrong shape for Connections,
 * where the backend picker is the axis every other setting hangs off. Stacking it put the picker
 * behind a row, so the only way to change backend was to open the row that stood for it, and opening
 * that row wrote global API state as a side effect. The backend is now chosen by a control that is on
 * screen whenever the tab is.
 *
 * Nothing here is authored from scratch where upstream already owns it. The provider blocks, the
 * connection-profiles markup, and the connect rows are the ones in `public/index.html` and the
 * connection-manager extension; they are moved, never cloned, so ids, jQuery data, and the handlers
 * `openai.js`, `textgen-settings.js`, `nai-settings.js`, `horde.js`, and `secrets.js` attached to them
 * all keep working. For the same reason the native `#main_api`, `#chat_completion_source`, and
 * `#textgen_type` selects stay in the document as the source of truth, and the controls drawn here
 * are views that read from them and write back by firing the `change` their own handlers listen for.
 *
 * `#rm_api_block` itself is kept attached and emptied: upstream looks it up by id to use as a select2
 * dropdown parent (`openai.js:2504`, `horde.js:468`, `textgen-models.js:1207`) and `script.js`
 * registers it as a layout target, so removing it would break those lookups.
 */

import { eventSource, event_types } from '../script.js';

/**
 * Marks the panel, so the stylesheet can scope to it and the rules that used to be keyed on
 * `#rm_api_block` have something to key on that survives the move.
 */
export const SB_CONNECTIONS_PANEL_CLASS = 'sb-connections-panel';

/** The title the panel's own heading carries. */
const SB_PANEL_TITLE = 'Connections';

/**
 * The three choices the backend control offers.
 *
 * Chat and Text are separated out because that is the division the ecosystem is actually in: they
 * are what almost every user configures, and each owns a long list of providers behind it. The
 * remaining three are complete backends with no providers behind them, so they share one entry
 * rather than padding the main control out to five items of very different weight.
 */
const SB_BACKENDS = Object.freeze([
    {
        id: 'chat',
        label: 'Chat Completions',
        api: 'openai',
        icon: 'fa-comment-dots',
        sourceControl: '#chat_completion_source',
    },
    {
        id: 'text',
        label: 'Text Completions',
        api: 'textgenerationwebui',
        icon: 'fa-keyboard',
        sourceControl: '#textgen_type',
    },
    {
        id: 'other',
        label: 'Other Backends',
        api: null,
        icon: 'fa-server',
        sourceControl: null,
    },
]);

/** The backends that live under Other Backends, in the order the row reads. */
const SB_OTHER_BACKENDS = Object.freeze([
    { api: 'novel', label: 'NovelAI', icon: 'fa-feather' },
    { api: 'koboldhorde', label: 'AI Horde', icon: 'fa-users' },
    { api: 'kobold', label: 'KoboldAI Classic', icon: 'fa-dragon' },
]);

/**
 * Which provider block belongs to which backend value.
 *
 * `block` is the element upstream switches between. It is moved into the panel once, with its
 * settings and its own `Source` select inside it, so moving the block moves the whole provider page.
 */
const SB_PROVIDER_BLOCKS = Object.freeze([
    { api: 'openai', block: '#openai_api' },
    { api: 'textgenerationwebui', block: '#textgenerationwebui_api' },
    { api: 'novel', block: '#novel_api' },
    { api: 'koboldhorde', block: '#kobold_horde' },
    { api: 'kobold', block: '#kobold_api' },
]);

/**
 * The connect row inside a provider block, and the button that identifies it.
 *
 * The row is lifted to the top of its own parent rather than to the top of the block, because the
 * mobile stylesheet targets it by that exact chain -- `#novel_api > form > .flex-container:has(>
 * #api_button_novel)` and friends -- and for three of the five backends the parent is a `<form>`
 * whose semantics the row belongs inside. Only its position among its siblings changes, so the
 * chain holds and the `display` toggles `openai.js` and `textgen-settings.js` write onto the row's
 * own children keep working.
 */
const SB_CONNECT_BUTTON_SELECTOR = '.api_button, #horde_api_key_button';

/**
 * The leftovers of the drawer that are not a provider and not the profile.
 *
 * The drawer's own title is dropped -- the panel draws its own heading -- and the row of controls
 * that apply to every backend rather than to one (auto-connecting on start, opening the hidden-key
 * viewer) is moved to the panel's footer, because it is not a provider setting.
 */
const SB_DRAWER_TITLE_SELECTOR = '#title_api';
const SB_DRAWER_FOOTER_SELECTOR = '.flex-container.alignitemscenter.spaceBetween.wide100p';
const SB_DRAWER_COLUMN_SELECTOR = '#main-API-selector-block';

/**
 * The api value a backend id stands for, or null for Other Backends.
 *
 * @param {string} backendId
 * @returns {string|null}
 */
function apiForBackend(backendId) {
    return SB_BACKENDS.find(backend => backend.id === backendId)?.api ?? null;
}

/**
 * Which backend id an `#main_api` value belongs to.
 *
 * @param {string} apiId
 * @returns {string}
 */
function backendForApi(apiId) {
    return SB_BACKENDS.find(backend => backend.api === apiId)?.id ?? 'other';
}

/**
 * Collapses an option's text into a label.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanLabel(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Builds the Connections panel.
 *
 * @param {object} deps
 * @param {(tagName: string, options?: object) => HTMLElement} deps.createElement
 * @param {() => string} deps.getActiveApi reads the current `#main_api` value
 * @param {(apiId: string) => void} deps.applyPanelApiVisibility runs the visibility half of the
 *     main-API change, which the caller owns because that function lives in `script.js`
 * @returns {object} the panel bundle
 */
export function createConnectionsPanel({
    createElement,
    getActiveApi,
    applyPanelApiVisibility,
}) {
    const column = createElement('div', {
        className: `sb-shell-column ${SB_CONNECTIONS_PANEL_CLASS}`,
        attrs: { 'data-sb-presentation': 'manual', 'data-sb-connections-panel': '' },
    });

    const heading = createElement('div', { className: 'sb-connections-heading' });
    heading.appendChild(createElement('h2', { className: 'sb-connections-title', text: SB_PANEL_TITLE }));

    const profileSlot = createElement('div', { className: 'sb-connections-profile' });
    const switcher = createElement('div', { className: 'sb-connections-switcher' });
    const backendRow = createElement('div', {
        className: 'sb-backend-switch',
        attrs: { role: 'tablist', 'aria-label': 'Backend' },
    });
    const sourceSlot = createElement('div', { className: 'sb-connections-source' });
    const body = createElement('div', { className: 'sb-connections-body' });
    const footer = createElement('div', { className: 'sb-connections-footer' });

    switcher.append(backendRow, sourceSlot);
    column.append(heading, profileSlot, switcher, body, footer);

    /** The slot each provider block is moved into, keyed by api id. */
    const providerSlots = new Map();
    for (const provider of SB_PROVIDER_BLOCKS) {
        const slot = createElement('section', {
            className: 'sb-connections-provider',
            attrs: { 'data-sb-provider': provider.api },
        });
        slot.hidden = true;
        providerSlots.set(provider.api, slot);
        body.appendChild(slot);
    }

    const state = {
        backend: 'chat',
        mounted: false,
        /** Every node this panel moved, so teardown can put it back. */
        moved: [],
        /** The teardown for the combo row currently on screen, if there is one. */
        comboTeardown: null,
        /** Which backend the on-screen combo row was built for. */
        comboFor: null,
        /** The listener the app's event bus holds, so it can be dropped on teardown. */
        unlisten: [],
    };

    const backendButtons = new Map();
    for (const backend of SB_BACKENDS) {
        const button = createElement('button', {
            type: 'button',
            className: 'sb-backend-switch-button',
            attrs: { role: 'tab', 'data-sb-backend': backend.id, 'aria-selected': 'false' },
        });
        const icon = createElement('i', {
            className: `fa-solid ${backend.icon}`,
            attrs: { 'aria-hidden': 'true' },
        });
        button.append(icon, document.createTextNode(backend.label));
        button.addEventListener('click', () => selectBackend(backend.id, { byHand: true }));
        backendButtons.set(backend.id, button);
        backendRow.appendChild(button);
    }

    /**
     * Moves a node into the panel, remembering where it came from.
     *
     * @param {HTMLElement} node
     * @param {HTMLElement} destination
     */
    function moveNode(node, destination) {
        state.moved.push({ node, parent: node.parentNode, next: node.nextSibling });
        destination.appendChild(node);
    }

    /**
     * Puts every moved node back where it came from, latest move first.
     */
    function restoreMoved() {
        for (const entry of state.moved.reverse()) {
            if (entry.next && entry.next.parentNode === entry.parent) {
                entry.parent.insertBefore(entry.node, entry.next);
            } else {
                entry.parent.appendChild(entry.node);
            }
        }
        state.moved.length = 0;
    }

    /**
     * Wraps a provider block's settings content (everything, including the connect card) in a pill.
     *
     * This gives Chat Completions the same pill container Text Completions already has via its form
     * wrapper. The connect card retains its own card styling, and everything below it inherits the
     * body padding. Called once per provider on each mount; the wrapper is skipped if already present.
     *
     * @param {HTMLElement} slot
     */
    function wrapProviderContent(slot) {
        const block = slot.querySelector('[id$="_api"], #kobold_horde');
        if (!(block instanceof HTMLElement)) {
            return;
        }
        if (block.querySelector(':scope > .sb-connections-provider-body')) {
            return;
        }

        // Wrap everything: the connect card and the settings below it. This ensures both Chat
        // Completions (where connect is a direct child) and Text Completions (where connect lives
        // inside a form) get the same pill structure. The connect card's own CSS outranks the
        // generic body > * padding, so it keeps its chrome. Everything that follows the connect
        // card inherits the body padding and border rules.
        const children = Array.from(block.children);
        if (children.length === 0) {
            return;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'sb-connections-provider-body';
        for (const child of children) {
            // A connect card authored directly on the block gets a plain slot, so it is inset by the
            // body padding exactly like the Text Completions form that holds its card.
            if (child.classList.contains('sb-connections-connect')) {
                const connectSlot = document.createElement('div');
                connectSlot.className = 'sb-connections-connect-slot';
                connectSlot.appendChild(child);
                wrapper.appendChild(connectSlot);
                continue;
            }
            wrapper.appendChild(child);
        }
        block.appendChild(wrapper);
    }

    /**
     * Lifts a provider's connect row to the top of the block, for the status card to style.
     *
     * The row is moved to the first position among its own siblings rather than relocated, so the
     * chain the mobile stylesheet matches it by -- and the `<form>` three of the five backends keep
     * it inside -- both survive. The status block is moved onto the row for the backends that author
     * it as a sibling of the form rather than inside it: it is written by id from `getStatusOpen()`
     * and `getStatusTextgen()`, so it has to travel with the button or a failed connection would
     * report somewhere the user is not looking.
     *
     * @param {HTMLElement} slot
     */
    function liftConnectRow(slot) {
        const button = slot.querySelector(SB_CONNECT_BUTTON_SELECTOR);
        const row = button?.closest('.flex-container') ?? null;
        if (!(row instanceof HTMLElement)) {
            return;
        }

        row.classList.add('sb-connections-connect');
        if (row.previousElementSibling) {
            row.parentElement?.prepend(row);
        }

        const status = slot.querySelector('.online_status');
        if (status instanceof HTMLElement && !row.contains(status)) {
            row.appendChild(status);
        }
    }

    /**
     * Mounts the upstream markup into the panel.
     *
     * The Connection Profile markup is authored into `#rm_api_block` by the connection-manager
     * extension, which runs long after this module loads, so mounting is retried on each activation
     * rather than assumed to succeed on the first call.
     */
    function mount() {
        const root = document.getElementById('rm_api_block');
        if (!(root instanceof HTMLElement)) {
            return;
        }

        // The profile card is authored as the first direct child of the drawer. It is moved whole,
        // so every action button inside it keeps its own listener and the extension keeps finding
        // its own ids.
        const profileCard = root.querySelector(':scope > .wide100p');
        if (profileCard instanceof HTMLElement && !profileSlot.contains(profileCard)) {
            moveNode(profileCard, profileSlot);
        }

        for (const provider of SB_PROVIDER_BLOCKS) {
            const block = root.querySelector(provider.block);
            const slot = providerSlots.get(provider.api);
            if (!(block instanceof HTMLElement) || !slot || slot.contains(block)) {
                continue;
            }
            // Upstream hides these with an inline style that `changeMainAPI` rewrites on every
            // switch. The panel decides visibility from here on, so the authored value is cleared
            // once and the stylesheet's rule for the slot takes over.
            block.style.removeProperty('display');
            moveNode(block, slot);
            liftConnectRow(slot);
            wrapProviderContent(slot);
        }

        // The drawer's own `API` title is dropped, because the panel has a heading of its own.
        const drawerTitle = root.querySelector(`:scope > ${SB_DRAWER_TITLE_SELECTOR}`);
        if (drawerTitle instanceof HTMLElement) {
            drawerTitle.classList.add('sb-connections-legacy');
        }

        // Everything else the drawer authored at its top level is either a provider block, already
        // moved, or a control for the whole tab rather than for one backend: auto-connect and the
        // hidden-key viewer. That row goes to the panel's footer, because it is not a provider
        // setting. `#main_api` and the column holding it stay where they are, since half the app
        // reads the select by id; the column is hidden rather than moved.
        const footerRow = root.querySelector(`:scope > ${SB_DRAWER_FOOTER_SELECTOR}`);
        if (footerRow instanceof HTMLElement && !footer.contains(footerRow)) {
            moveNode(footerRow, footer);
        }

        const pickerColumn = root.querySelector(`:scope > ${SB_DRAWER_COLUMN_SELECTOR}`);
        pickerColumn?.closest('.flex-container')?.classList.add('sb-connections-legacy');

        state.mounted = true;
    }

    /**
     * Paints the backend control and the source control for the current selection.
     *
     * @param {string} [flashBackend] a backend to highlight briefly, for a profile-driven change
     */
    function renderSwitcher(flashBackend = '') {
        for (const [id, button] of backendButtons) {
            const selected = id === state.backend;
            button.setAttribute('aria-selected', String(selected));
            button.classList.toggle('is-selected', selected);
        }

        if (flashBackend && backendButtons.has(flashBackend)) {
            const button = backendButtons.get(flashBackend);
            button.classList.remove('is-flash');
            // Read a layout property so the animation restarts even when the same pill is re-selected.
            void button.offsetWidth;
            button.classList.add('is-flash');
        }

        renderSourceControl();
    }

    /**
     * Paints the provider control for the active backend.
     *
     * Chat and Text each have a long list of providers behind them, and a list of twenty-nine is not
     * a two-or-three-way choice -- so it reads as a libadwaita combo row rather than as more pills.
     * Other Backends has no provider, so its slot holds the three backends themselves.
     *
     * The row is only rebuilt when the backend actually changes: it is a control a user is in the
     * middle of using, and rebuilding it under an open list would close the list on them.
     */
    function renderSourceControl() {
        if (state.comboFor === state.backend && sourceSlot.childElementCount > 0) {
            return;
        }

        state.comboTeardown?.();
        state.comboTeardown = null;
        state.comboFor = state.backend;
        sourceSlot.replaceChildren();

        const backend = SB_BACKENDS.find(entry => entry.id === state.backend);
        if (!backend) {
            return;
        }

        if (backend.id === 'other') {
            sourceSlot.appendChild(buildOtherBackendRow());
            return;
        }

        const select = backend.sourceControl ? document.querySelector(backend.sourceControl) : null;
        if (!(select instanceof HTMLSelectElement)) {
            return;
        }

        const combo = buildComboRow(select, 'Source');
        state.comboTeardown = combo.teardown;
        sourceSlot.appendChild(combo.row);
    }

    /**
     * The row of the three provider-less backends.
     *
     * @returns {HTMLElement}
     */
    function buildOtherBackendRow() {
        const row = createElement('div', {
            className: 'sb-other-backend-switch',
            attrs: { role: 'tablist', 'aria-label': 'Other backends' },
        });
        const active = getActiveApi();

        for (const backend of SB_OTHER_BACKENDS) {
            const button = createElement('button', {
                type: 'button',
                className: 'sb-other-backend-button',
                attrs: {
                    role: 'tab',
                    'data-sb-api': backend.api,
                    'aria-selected': String(active === backend.api),
                },
            });
            const icon = createElement('i', {
                className: `fa-solid ${backend.icon}`,
                attrs: { 'aria-hidden': 'true' },
            });
            button.append(icon, document.createTextNode(backend.label));
            button.addEventListener('click', () => selectBackend('other', { apiId: backend.api }));
            row.appendChild(button);
        }

        return row;
    }

    /**
     * Writes a value to a native select and fires the change upstream listens for.
     *
     * Nothing is set behind upstream's back: the change is dispatched on the real control, so the
     * handler that saves the setting and emits its event runs, and every other panel that keys off
     * the value follows. Re-selecting the value already in effect is skipped, because re-running the
     * full change would reset the connection status and drop a live connection to make a change that
     * is not happening.
     *
     * @param {HTMLSelectElement|HTMLElement|null} select
     * @param {string} value
     * @returns {boolean} whether a change was dispatched
     */
    function applySelectValue(select, value) {
        if (!(select instanceof HTMLSelectElement) || select.value === value) {
            return false;
        }
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    /**
     * Applies an `#main_api` value.
     *
     * @param {string} apiId
     */
    function applyApi(apiId) {
        const select = document.getElementById('main_api');
        if (!(select instanceof HTMLSelectElement)) {
            return;
        }
        if (select.value === apiId) {
            // Already the active backend. Only the visibility pass is wanted: the full change would
            // drop a live connection to make a change that is not happening.
            applyPanelApiVisibility(apiId);
            return;
        }
        if (!applySelectValue(select, apiId)) {
            applyPanelApiVisibility(apiId);
        }
    }

    /**
     * Clears the connection profile picker, if one is selected.
     *
     * A backend chosen by hand leaves the loaded profile describing a configuration that is no
     * longer in effect, so the panel stops claiming it is. Reconciling the two is what upstream's
     * own Update button is for.
     */
    function clearProfileSelection() {
        const picker = document.getElementById('connection_profiles');
        if (!(picker instanceof HTMLSelectElement) || !picker.value) {
            return;
        }
        picker.value = '';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Shows the slot for the active backend and hides the rest.
     */
    function updateProviderSlots() {
        const active = getActiveApi();
        for (const [providerApi, slot] of providerSlots) {
            slot.hidden = providerApi !== active;
        }
    }

    /**
     * Brings the switcher back in line with the active backend.
     *
     * The pills are not the only thing that moves `#main_api`: a loaded connection profile, the
     * `/api` slash command, the top-bar connection strip, and the reconnect paths in `openai.js`
     * and `textgen-settings.js` all do. Reading the value back rather than trusting the pill that
     * was clicked is what keeps the panel honest about which backend is in use.
     *
     * @param {{flashChange?: boolean}} [options]
     */
    function syncFromApi(options = {}) {
        mount();
        const active = getActiveApi();
        const nextBackend = backendForApi(active);
        const changed = nextBackend !== state.backend;
        state.backend = nextBackend;
        updateProviderSlots();
        applyPanelApiVisibility(active);
        renderSwitcher(options.flashChange && changed ? nextBackend : '');
    }

    /**
     * Switches the visible backend.
     *
     * @param {string} backendId
     * @param {{byHand?: boolean, apiId?: string}} [options]
     */
    function selectBackend(backendId, options = {}) {
        if (options.byHand) {
            clearProfileSelection();
        }

        // Other Backends is a group of three, so the click that landed on one of them is the value
        // to apply; the group's own pill has no api of its own.
        const apiId = options.apiId ?? apiForBackend(backendId);
        if (apiId) {
            applyApi(apiId);
        } else {
            // The group pill keeps whichever of its three is currently active, and only falls back to
            // the first when the active backend is one of the other two.
            const current = getActiveApi();
            if (!SB_OTHER_BACKENDS.some(backend => backend.api === current)) {
                applyApi(SB_OTHER_BACKENDS[0].api);
            }
        }

        syncFromApi({ flashChange: false });
    }

    /**
     * Builds the combo row that stands in for a native select.
     *
     * The select stays the source of truth and stays in the document, hidden, because upstream and
     * extensions read and write it by id. The row mirrors its options in full -- including any an
     * extension appended -- and writes a selection back through `applySelectValue`. Its own state is
     * never written on build: the row reads the select's persisted value so a revisit shows the
     * provider actually in use rather than resetting it to the first option.
     *
     * @param {HTMLSelectElement} select
     * @param {string} label
     * @returns {{row: HTMLElement, teardown: () => void}}
     */
    function buildComboRow(select, label) {
        const row = createElement('div', { className: 'sb-combo-row' });
        const title = createElement('span', { className: 'sb-combo-row-title', text: label });
        const trigger = createElement('button', {
            type: 'button',
            className: 'sb-combo-trigger',
            attrs: {
                role: 'combobox',
                'aria-haspopup': 'listbox',
                'aria-expanded': 'false',
                'aria-label': label,
            },
        });
        const value = createElement('span', { className: 'sb-combo-value' });
        const chevron = createElement('i', {
            className: 'sb-combo-chevron fa-solid fa-chevron-down',
            attrs: { 'aria-hidden': 'true' },
        });
        trigger.append(value, chevron);

        const list = createElement('div', {
            className: 'sb-combo-list',
            attrs: { role: 'listbox', 'aria-label': label },
        });
        list.hidden = true;

        const close = () => {
            list.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            row.classList.remove('is-open');
        };

        const paint = () => {
            const selected = select.selectedOptions?.[0] ?? null;
            value.textContent = cleanLabel(selected?.textContent ?? select.value);
            for (const option of list.querySelectorAll('.sb-combo-option')) {
                const isSelected = option.dataset.sbValue === select.value;
                option.setAttribute('aria-selected', String(isSelected));
                option.classList.toggle('is-selected', isSelected);
            }
        };

        const buildOption = option => {
            const button = createElement('button', {
                type: 'button',
                className: 'sb-combo-option',
                text: cleanLabel(option.textContent),
                attrs: { role: 'option', 'data-sb-value': option.value },
            });
            button.addEventListener('click', () => {
                applySelectValue(select, option.value);
                paint();
                close();
                trigger.focus();
            });
            return button;
        };

        // Read from the select rather than captured once: several extensions append providers to
        // these lists as they initialise, and a captured list would drop them.
        const rebuildOptions = () => {
            list.replaceChildren();
            for (const child of select.children) {
                if (child instanceof HTMLOptGroupElement) {
                    list.appendChild(createElement('div', {
                        className: 'sb-combo-group',
                        text: cleanLabel(child.label),
                        attrs: { role: 'presentation' },
                    }));
                    for (const option of child.children) {
                        list.appendChild(buildOption(option));
                    }
                    continue;
                }
                if (child instanceof HTMLOptionElement) {
                    list.appendChild(buildOption(child));
                }
            }
            paint();
        };

        trigger.addEventListener('click', event => {
            event.stopPropagation();
            const willOpen = list.hidden;
            if (willOpen) {
                rebuildOptions();
            }
            list.hidden = !willOpen;
            trigger.setAttribute('aria-expanded', String(willOpen));
            row.classList.toggle('is-open', willOpen);
        });

        // Closing on an outside press rather than on blur: on touch, blur fires before the click
        // that selects an option, and closing on blur would swallow the selection.
        const onDocumentPointerDown = event => {
            if (event.target instanceof Node && !row.contains(event.target)) {
                close();
            }
        };
        document.addEventListener('pointerdown', onDocumentPointerDown, true);

        const observer = new MutationObserver(rebuildOptions);
        observer.observe(select, { childList: true, subtree: true });

        // The native select is hidden, so a change made anywhere else -- a preset, a connection
        // profile, a slash command -- has to be reflected here. jQuery's `.trigger('change')` only
        // walks jQuery's handler list and never fires native addEventListener listeners, so this
        // must be bound through jQuery to catch profile-driven source changes.
        const onSelectChange = () => paint();
        $(select).on('change', onSelectChange);

        rebuildOptions();
        row.append(title, trigger, list);

        return {
            row,
            teardown: () => {
                observer.disconnect();
                $(select).off('change', onSelectChange);
                document.removeEventListener('pointerdown', onDocumentPointerDown, true);
            },
        };
    }

    /**
     * Watches the legacy drawer for the markup extensions author into it after boot.
     *
     * `#rm_api_block` is built by upstream, but the connection-profile card inside it is written by
     * the connection-manager extension, which finishes loading well after the shell is built. The
     * panel is not rebuilt when it arrives -- a second build would move nodes out of a panel being
     * torn down -- so it mounts the card whenever the drawer gains one.
     */
    function observeUpstreamMarkup() {
        const root = document.getElementById('rm_api_block');
        if (!(root instanceof HTMLElement) || root.dataset.sbConnectionsObserved === 'true') {
            return;
        }
        root.dataset.sbConnectionsObserved = 'true';
        const observer = new MutationObserver(() => mount());
        observer.observe(root, { childList: true });
        state.unlisten.push(() => {
            observer.disconnect();
            delete root.dataset.sbConnectionsObserved;
        });
    }

    /**
     * Subscribes to the event a backend change emits from anywhere in the app.
     *
     * A pill click is not the only way `#main_api` moves, and the top-bar connection strip and the
     * `/api` slash command both move it without ever touching this panel. Listening for the change
     * rather than trusting the click is what keeps the pills from drifting out of agreement with the
     * backend actually in use.
     */
    function bindEvents() {
        if (!eventSource?.on || !event_types?.MAIN_API_CHANGED) {
            return;
        }
        const name = event_types.MAIN_API_CHANGED;
        const handler = () => syncFromApi({ flashChange: true });
        eventSource.on(name, handler);
        state.unlisten.push(() => eventSource.off?.(name, handler));
    }

    mount();
    observeUpstreamMarkup();
    bindEvents();
    syncFromApi({ flashChange: false });

    return {
        column,
        /** Called on every activation, so a profile applied elsewhere lands on the right page. */
        onActivate: () => syncFromApi({ flashChange: false }),
        /** Called when something outside the pills moved the backend, to highlight the change. */
        syncFromApi,
        selectBackend,
        teardown: () => {
            state.comboTeardown?.();
            state.comboTeardown = null;
            for (const remove of state.unlisten.splice(0)) {
                remove();
            }
            restoreMoved();
            state.mounted = false;
        },
        /** Exposed so the settings search index and the tests can read the panel's own state. */
        getBackend: () => state.backend,
        isMounted: () => state.mounted,
    };
}
