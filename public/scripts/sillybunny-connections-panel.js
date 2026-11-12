/**
 * SillyBunny's Connections presentation adapter.
 *
 * Upstream owns the connection controls and their handlers. This module only moves those nodes into
 * preference groups and mirrors native selects with the shared picker rows. The legacy drawer stays
 * attached because select2 uses it as a dropdown parent.
 */

import { closeActionMenu, isActionMenuOpen, openActionMenu } from './sillybunny-action-menu.js';
import { loadListEditorStyles } from './sillybunny-editor/list-shell.js';
import { createButtonRow, createPrefGroup, createSwitchRow } from './sillybunny-editor/rows.js';
import { createProfileRow, createSelectRow } from './sillybunny-editor/select-row.js';
import { createToggleRow } from './sillybunny-editor/toggle-row.js';
import { t } from './i18n.js';
import { applyConnectionsFormPass } from './sillybunny-connections-form.js';
import { applyConnectionsGroups } from './sillybunny-connections-groups.js';
import { eventSource, event_types } from '../script.js';

export const SB_CONNECTIONS_PANEL_CLASS = 'sb-connections-panel';

const SB_BACKENDS = Object.freeze([
    { id: 'chat', api: 'openai', sourceControl: '#chat_completion_source' },
    { id: 'text', api: 'textgenerationwebui', sourceControl: '#textgen_type' },
    { id: 'other', api: null, sourceControl: null },
]);

const SB_OTHER_BACKENDS = Object.freeze([
    { api: 'novel' },
    { api: 'koboldhorde' },
    { api: 'kobold' },
]);

const SB_PROVIDER_BLOCKS = Object.freeze([
    { api: 'openai', block: '#openai_api' },
    { api: 'textgenerationwebui', block: '#textgenerationwebui_api' },
    { api: 'novel', block: '#novel_api' },
    { api: 'koboldhorde', block: '#kobold_horde' },
    { api: 'kobold', block: '#kobold_api' },
]);

const SB_CONNECT_BUTTON_SELECTOR = '.api_button';

function apiForBackend(backendId) {
    return SB_BACKENDS.find(backend => backend.id === backendId)?.api ?? null;
}

function backendForApi(apiId) {
    return SB_BACKENDS.find(backend => backend.api === apiId)?.id ?? 'other';
}

function createHelpButton() {
    const help = document.createElement('a');
    help.className = 'sb-connections-help';
    help.href = 'https://docs.sillytavern.app/usage/core-concepts/connection-profiles';
    help.target = '_blank';
    help.rel = 'noreferrer';
    help.setAttribute('aria-label', t`Help`);
    help.title = t`Help`;
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-circle-question';
    icon.setAttribute('aria-hidden', 'true');
    help.append(icon);
    return help;
}

/**
 * Creates the Connections view over upstream's existing nodes.
 * @param {object} deps
 * @param {(tagName: string, options?: object) => HTMLElement} deps.createElement
 * @param {() => string} deps.getActiveApi
 * @param {(apiId: string) => void} deps.applyPanelApiVisibility
 * @returns {object}
 */
export function createConnectionsPanel({ createElement, getActiveApi, applyPanelApiVisibility }) {
    const column = createElement('div', {
        className: `sb-shell-column ${SB_CONNECTIONS_PANEL_CLASS}`,
        attrs: { 'data-sb-presentation': 'manual', 'data-sb-connections-panel': '' },
    });
    const state = {
        backend: backendForApi(getActiveApi()),
        mounted: false,
        profileMounted: false,
        generalMounted: false,
        otherSelect: null,
        moved: [],
        generated: [],
        controllers: [],
        legacyClasses: [],
        restorePresentation: [],
        attributeSnapshots: new WeakSet(),
        unlisten: [],
        sourceRows: new Map(),
        providerSlots: new Map(),
        providerGroups: [],
    };

    const profileGroup = createPrefGroup({
        title: t`Connection Profile`,
        subtitle: t`Setup all-in-one profiles that save all your settings in one go`,
        field: 'profile',
        headerSuffix: createHelpButton(),
    });
    profileGroup.section.classList.add('sb-connections-profile');

    const backendGroup = createPrefGroup({
        title: t`Backend`,
        subtitle: t`Change the backend source and type here. Chat Completions is recommended by default`,
        field: 'backend',
    });
    backendGroup.section.classList.add('sb-connections-backend');
    const generalGroup = createPrefGroup({ title: t`General`, subtitle: t`Settings that affect all connection types`, field: 'general' });

    const providerSlots = [];
    for (const provider of SB_PROVIDER_BLOCKS) {
        const slot = createElement('section', {
            className: 'sb-connections-provider',
            attrs: { 'data-sb-provider': provider.api },
        });
        slot.hidden = true;
        providerSlots.push(slot);
        state.providerSlots.set(provider.api, slot);
    }
    column.append(profileGroup.section, backendGroup.section, ...providerSlots, generalGroup.section);

    const backendToggle = createToggleRow({
        label: t`Backend Type`,
        field: 'backend-type',
        fill: true,
        choices: [
            ['chat', t`Chat Completions`],
            ['text', t`Text Completions`],
            ['other', t`Other`],
        ],
        value: state.backend,
        onChange: next => selectBackend(next, { byHand: true }),
    });
    backendGroup.append(backendToggle);
    state.controllers.push(backendToggle);

    function moveNode(node, destination) {
        if (!(node instanceof Node) || !(destination instanceof Node)) return;
        if (node instanceof Element) snapshotAttributes(node);
        state.moved.push({ node, parent: node.parentNode, next: node.nextSibling });
        destination.appendChild(node);
    }

    function restoreMoved() {
        for (const entry of state.moved.reverse()) {
            if (!entry.node.isConnected || !(entry.parent instanceof Node)) continue;
            if (entry.next instanceof Node && entry.next.parentNode === entry.parent) {
                entry.parent.insertBefore(entry.node, entry.next);
            } else {
                entry.parent.appendChild(entry.node);
            }
        }
        state.moved.length = 0;
    }

    function addLegacyClass(node, className) {
        if (!(node instanceof HTMLElement)) return;
        if (node.classList.contains(className)) return;
        snapshotAttributes(node);
        node.classList.add(className);
        state.legacyClasses.push({ node, className });
    }

    function recordPresentationAttribute(node, name) {
        const previous = node.getAttribute(name);
        state.restorePresentation.push(() => {
            if (previous === null) node.removeAttribute(name);
            else node.setAttribute(name, previous);
        });
    }

    function snapshotAttributes(node) {
        if (state.attributeSnapshots.has(node)) return;
        state.attributeSnapshots.add(node);
        const attributes = [...node.attributes].map(({ name, value }) => [name, value]);
        state.restorePresentation.push(() => {
            for (const { name } of [...node.attributes]) node.removeAttribute(name);
            for (const [name, value] of attributes) node.setAttribute(name, value);
        });
    }

    function setPresentationAttribute(node, name, value) {
        recordPresentationAttribute(node, name);
        node.setAttribute(name, value);
    }

    function clearProfileSelection() {
        const picker = document.getElementById('connection_profiles');
        if (!(picker instanceof HTMLSelectElement) || !picker.value) return;
        picker.value = '';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function applySelectValue(select, value) {
        if (!(select instanceof HTMLSelectElement) || select.value === value) {
            return false;
        }
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function applyApi(apiId) {
        const select = document.getElementById('main_api');
        if (!(select instanceof HTMLSelectElement)) return;
        if (select.value === apiId) {
            applyPanelApiVisibility(apiId);
            return;
        }
        if (!applySelectValue(select, apiId)) applyPanelApiVisibility(apiId);
    }

    function selectBackend(backendId, options = {}) {
        if (options.byHand) clearProfileSelection();
        const apiId = options.apiId ?? apiForBackend(backendId);
        if (apiId) {
            applyApi(apiId);
        } else {
            const current = getActiveApi();
            const fallback = SB_OTHER_BACKENDS.some(backend => backend.api === current)
                ? current
                : SB_OTHER_BACKENDS[0].api;
            applyApi(fallback);
        }
        syncFromApi();
    }

    function profileActionItems() {
        const actions = [
            ['update_connection_profile', t`Update`],
            ['reload_connection_profile', t`Reload`],
            ['create_connection_profile', t`New…`],
            ['edit_connection_profile', t`Edit…`],
            ['view_connection_profile', t`View Details`],
            ['toggle_profile_favorite', t`Favorite`],
            ['manage_profile_folders', t`Manage Folders…`],
            ['delete_connection_profile', t`Delete…`],
            ['delete_all_connection_profiles', t`Delete All…`],
        ];
        const findAction = id => document.getElementById(id);
        const item = ([id, label]) => {
            const original = findAction(id);
            if (!(original instanceof HTMLElement)) return null;
            const disabled = original.classList.contains('disabled')
                || original.hasAttribute('disabled')
                || original.getAttribute('aria-disabled') === 'true';
            return {
                label,
                icon: original.querySelector('i')?.className,
                disabled,
                ...(id === 'toggle_profile_favorite' ? { checked: original.getAttribute('aria-pressed') === 'true' } : {}),
                ...(id.startsWith('delete_') ? { danger: true } : {}),
                onSelect: () => original.click(),
            };
        };
        const items = actions.map(item);
        return [
            { items: items.slice(0, 2).filter(Boolean) },
            { items: items.slice(2, 5).filter(Boolean) },
            { items: items.slice(5, 7).filter(Boolean) },
            { items: items.slice(7).filter(Boolean) },
        ];
    }

    function mountProfile(root) {
        if (state.profileMounted) return;
        const profileCard = root.querySelector(':scope > .wide100p');
        const profileSelect = profileCard?.querySelector('#connection_profiles');
        if (!(profileCard instanceof HTMLElement) || !(profileSelect instanceof HTMLSelectElement)) return;

        // The shell is still detached during its first mount: resolve children before adopting the card.
        const spinner = profileCard.querySelector('#connection_profile_spinner');
        const summary = profileCard.querySelector('#sb-connection-profile-sets');
        const legacy = createElement('div', { className: 'sb-connections-legacy' });
        state.generated.push(legacy);
        moveNode(profileCard, legacy);
        profileGroup.group.append(legacy);

        moveNode(profileSelect, profileGroup.group);
        if (spinner instanceof HTMLElement) moveNode(spinner, profileGroup.group);
        if (summary instanceof HTMLElement) {
            moveNode(summary, profileGroup.group);
            addLegacyClass(summary, 'ds-row-subtitle');
        }

        const profileRow = createProfileRow({
            select: profileSelect,
            label: t`Profile`,
            field: 'connection-profile',
            title: t`Connection Profile`,
            searchLabel: t`Search Profiles`,
            menuLabel: t`Profile Menu`,
            suffix: spinner ? [spinner] : [],
            onMenu: menuButton => openActionMenu({
                trigger: menuButton,
                title: t`Connection Profile`,
                sections: profileActionItems(),
            }),
        });
        if (summary instanceof HTMLElement) {
            const text = profileRow.row.querySelector('.ds-row-text');
            text?.append(summary);
            profileRow.trigger.setAttribute('aria-describedby', summary.id);
        }
        profileGroup.append(profileRow);
        state.controllers.push(profileRow);
        // Controllers are destroyed in reverse, so this closes a still-open menu before its trigger goes.
        state.controllers.push({
            destroy: () => {
                if (isActionMenuOpen(profileRow.menuButton)) closeActionMenu({ animate: false });
            },
        });
        state.profileMounted = true;
    }

    function sourceLabel(select) {
        const heading = select.previousElementSibling;
        if (heading instanceof HTMLElement && heading.matches('h4')) addLegacyClass(heading, 'sb-connections-source-label');
    }

    function createOtherSelect() {
        const select = document.createElement('select');
        select.className = 'sb-connections-other-source';
        const labels = { novel: t`NovelAI`, koboldhorde: t`AI Horde`, kobold: t`KoboldAI Classic` };
        for (const backend of SB_OTHER_BACKENDS) {
            const option = document.createElement('option');
            option.value = backend.api;
            option.textContent = labels[backend.api];
            select.append(option);
        }
        const active = getActiveApi();
        select.value = SB_OTHER_BACKENDS.some(backend => backend.api === active) ? active : SB_OTHER_BACKENDS[0].api;
        return select;
    }

    function mountSourceRows() {
        for (const backend of SB_BACKENDS) {
            if (state.sourceRows.has(backend.id)) continue;
            const select = backend.sourceControl ? column.querySelector(backend.sourceControl) : createOtherSelect();
            if (!(select instanceof HTMLSelectElement)) continue;
            if (backend.sourceControl) {
                sourceLabel(select);
                moveNode(select, backendGroup.group);
            } else {
                state.otherSelect = select;
            }
            const row = createSelectRow({
                select,
                label: t`Source`,
                field: `source-${backend.id}`,
                title: t`Source`,
                searchLabel: t`Search Sources`,
                onPick: clearProfileSelection,
                onChange: backend.id === 'other'
                    ? value => {
                        applyApi(value);
                        syncFromApi();
                    }
                    : undefined,
            });
            row.row.dataset.sbBackendSource = backend.id;
            backendGroup.append(row);
            state.sourceRows.set(backend.id, row);
            state.controllers.push(row);
        }
    }

    function updateSourceRows() {
        for (const [backendId, row] of state.sourceRows) row.setVisible(backendId === state.backend);
        const active = getActiveApi();
        if (state.otherSelect && SB_OTHER_BACKENDS.some(backend => backend.api === active)) {
            state.otherSelect.value = active;
            state.sourceRows.get('other')?.sync();
        }
    }

    function updateProviderSlots() {
        const active = getActiveApi();
        for (const [providerApi, slot] of state.providerSlots) slot.hidden = providerApi !== active;
    }

    function liftConnectRow(slot) {
        const status = slot.querySelector('.online_status');
        if (!(status instanceof HTMLElement)) return null;
        if (slot.dataset.sbProvider === 'koboldhorde') {
            const statusRow = createElement('div', {
                className: 'sb-connections-connect sb-connections-status-row',
                attrs: { role: 'group', 'aria-label': t`Status` },
            });
            const form = status.parentElement;
            form?.prepend(statusRow);
            moveNode(status, statusRow);
            state.generated.push(statusRow);
            return statusRow;
        }
        const button = slot.querySelector(SB_CONNECT_BUTTON_SELECTOR);
        const row = button?.closest('.flex-container');
        if (!(row instanceof HTMLElement)) return null;

        addLegacyClass(row, 'sb-connections-connect');
        addLegacyClass(row, 'sb-connections-status-row');
        setPresentationAttribute(row, 'role', 'group');
        setPresentationAttribute(row, 'aria-label', t`Status`);
        const parent = row.parentElement;
        if (parent && row.previousElementSibling) {
            moveNode(row, parent);
            parent.prepend(row);
        }

        if (!row.contains(status)) moveNode(status, row);
        row.prepend(status);
        row.querySelectorAll('.api_button, .api_loading').forEach(control => addLegacyClass(control, 'suggested-action'));
        return row;
    }

    function moveSecondaryStatusControls(row) {
        const extras = document.createElement('div');
        extras.className = 'flex-container sb-connections-status-extra';
        extras.setAttribute('role', 'group');
        extras.setAttribute('aria-label', t`Status`);
        const controls = [...row.querySelectorAll('.openrouter_authorize, #customize_additional_parameters')];
        if (!controls.length || !(row.parentElement instanceof HTMLElement)) return;
        for (const control of controls) {
            moveNode(control, extras);
            if (!control.matches('.openrouter_authorize')) continue;
            addLegacyClass(control, 'ds-row');
            addLegacyClass(control, 'ds-button-row');
            control.setAttribute('role', 'button');
            control.tabIndex = 0;
            const keydown = event => {
                if (event.target !== control || !['Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                control.click();
            };
            control.addEventListener('keydown', keydown);
            state.controllers.push({ destroy() { control.removeEventListener('keydown', keydown); } });
        }
        row.parentElement.insertBefore(extras, row.nextSibling);
        state.generated.push(extras);
    }

    function wrapProviderContent(slot) {
        const block = [...slot.children].find(child => child.matches('[id$="_api"], #kobold_horde'));
        if (!(block instanceof HTMLElement) || block.querySelector(':scope > .sb-connections-provider-body')) return;
        const children = Array.from(block.children);
        if (!children.length) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'sb-connections-provider-body';
        state.generated.push(wrapper);
        for (const child of children) {
            if (child.classList.contains('sb-connections-connect')) {
                const connectSlot = document.createElement('div');
                connectSlot.className = 'sb-connections-connect-slot';
                state.generated.push(connectSlot);
                moveNode(child, connectSlot);
                wrapper.append(connectSlot);
                continue;
            }
            moveNode(child, wrapper);
        }
        block.append(wrapper);
    }

    function mountProviders(root) {
        for (const provider of SB_PROVIDER_BLOCKS) {
            const slot = state.providerSlots.get(provider.api);
            const block = root.querySelector(provider.block);
            if (!(slot instanceof HTMLElement) || !(block instanceof HTMLElement) || slot.contains(block)) continue;
            recordPresentationAttribute(block, 'style');
            block.style.removeProperty('display');
            moveNode(block, slot);
            const row = liftConnectRow(slot);
            if (row) moveSecondaryStatusControls(row);
            wrapProviderContent(slot);
            applyConnectionsFormPass(block, {
                moveNode, addLegacyClass, snapshotAttributes,
                controllers: state.controllers, generated: state.generated, t,
            });
            state.providerGroups.push(applyConnectionsGroups(block, {
                moveNode, addLegacyClass, snapshotAttributes,
                controllers: state.controllers, generated: state.generated, t,
            }));
        }
    }

    function mountGeneralControls(root) {
        if (state.generalMounted) return;
        const input = document.getElementById('auto-connect-checkbox');
        const viewSecrets = document.getElementById('viewSecrets');
        const footer = root.querySelector(':scope > .flex-container.alignitemscenter.spaceBetween.wide100p');
        if (!(input instanceof HTMLInputElement) || !(viewSecrets instanceof HTMLElement)) return;
        if (footer instanceof HTMLElement) addLegacyClass(footer, 'sb-connections-legacy');

        const label = t`Auto-connect to Last Server`;
        const subtitle = t`Connect to the last used server when SillyBunny opens.`;
        moveNode(input, generalGroup.group);
        const inputClass = input.getAttribute('class');
        const inputRole = input.getAttribute('role');
        const inputDescription = input.getAttribute('aria-describedby');
        state.restorePresentation.push(() => {
            for (const [name, previous] of [['class', inputClass], ['role', inputRole], ['aria-describedby', inputDescription]]) {
                if (previous === null) input.removeAttribute(name);
                else input.setAttribute(name, previous);
            }
        });
        const switchRow = createSwitchRow({
            input,
            label,
            subtitle,
            field: 'auto-connect',
        });
        const originalViewSecrets = viewSecrets;
        const buttonRow = createButtonRow({
            label: t`View Hidden API Keys`,
            field: 'view-hidden-api-keys',
            onActivate: () => originalViewSecrets.click(),
        });
        generalGroup.append(switchRow, buttonRow);
        state.controllers.push(switchRow, buttonRow);
        state.generalMounted = true;
    }

    function mount() {
        const root = document.getElementById('rm_api_block');
        if (!(root instanceof HTMLElement)) return;
        loadListEditorStyles();
        mountProfile(root);
        mountProviders(root);
        mountSourceRows();
        mountGeneralControls(root);
        state.mounted = true;
        updateProviderSlots();
        updateSourceRows();
    }

    function syncFromApi() {
        mount();
        const active = getActiveApi();
        state.backend = backendForApi(active);
        backendToggle.setValue(state.backend);
        updateProviderSlots();
        updateSourceRows();
        applyPanelApiVisibility(active);
        for (const groups of state.providerGroups) groups?.sync();
    }

    function observeUpstreamMarkup() {
        const root = document.getElementById('rm_api_block');
        if (!(root instanceof HTMLElement) || root.dataset.sbConnectionsObserved === 'true') return;
        root.dataset.sbConnectionsObserved = 'true';
        const observer = new MutationObserver(() => mount());
        observer.observe(root, { childList: true });
        state.unlisten.push(() => {
            observer.disconnect();
            delete root.dataset.sbConnectionsObserved;
        });
    }

    function bindEvents() {
        for (const id of ['chat_completion_source', 'textgen_type']) {
            const select = column.querySelector(`#${id}`);
            const handler = () => { for (const groups of state.providerGroups) groups?.sync(); };
            if (globalThis.jQuery) {
                globalThis.jQuery(select).on('change.sbConnectionsGroups', handler);
                state.unlisten.push(() => globalThis.jQuery(select).off('change.sbConnectionsGroups', handler));
            } else if (select) {
                select.addEventListener('change', handler);
                state.unlisten.push(() => select.removeEventListener('change', handler));
            }
        }
        if (!eventSource?.on || !event_types?.MAIN_API_CHANGED) return;
        const name = event_types.MAIN_API_CHANGED;
        const handler = () => syncFromApi();
        eventSource.on(name, handler);
        state.unlisten.push(() => eventSource.off?.(name, handler));
    }

    mount();
    observeUpstreamMarkup();
    bindEvents();
    syncFromApi();

    return {
        column,
        onActivate: () => syncFromApi(),
        syncFromApi,
        selectBackend,
        teardown: () => {
            const selects = [...column.querySelectorAll('.ds-select-row select')];
            for (const remove of state.unlisten.splice(0)) remove();
            restoreMoved();
            for (const select of selects) {
                const container = globalThis.jQuery?.(select).data('select2')?.$container?.[0];
                if (select.isConnected && container) select.after(container);
            }
            for (const controller of state.controllers.splice(0).reverse()) controller.destroy?.();
            for (const restore of state.restorePresentation.splice(0).reverse()) restore();
            for (const node of state.generated.splice(0).reverse()) node.remove();
            for (const { node, className } of state.legacyClasses.splice(0).reverse()) node.classList.remove(className);
            state.mounted = false;
            state.profileMounted = false;
            state.generalMounted = false;
        },
        getBackend: () => state.backend,
        isMounted: () => state.mounted,
    };
}
