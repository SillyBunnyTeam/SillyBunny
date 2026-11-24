import { openActionMenu } from '../sillybunny-action-menu.js';
import { createPresetAutosaveToggle, refreshPresetProtectionUi } from '../sillybunny-preset-autosave.js';
import { initializePromptEditor } from '../sillybunny-prompt-editor.js';
import { createButtonRow } from '../sillybunny-editor/rows.js';
import { createProfileRow } from '../sillybunny-editor/select-row.js';
import { t, translate } from '../i18n.js';
import {
    SB_USER_SETTINGS_CONTAINER_IDS,
    flattenNestedSettingsDrawers,
} from '../sillybunny-settings-content.js';
import { normalizeBackendSettingsRows } from '../sillybunny-settings-presentation.js';

const SB_BACKEND_TITLES = Object.freeze([
    { apiIds: ['openai'], title: 'Chat Completions' },
    { apiIds: ['textgenerationwebui'], title: 'Text Completions' },
    { apiIds: ['kobold', 'koboldhorde'], title: 'Kobold/Horde' },
    { apiIds: ['novel'], title: 'NovelAI' },
]);

const SB_PRESET_BLOCK_BY_API = Object.freeze({
    kobold: 'kobold_api-presets',
    koboldhorde: 'kobold_api-presets',
    novel: 'novel_api-presets',
    textgenerationwebui: 'textgenerationwebui_api-presets',
    openai: 'openai_api-presets',
});

/** Picker and menu titles reuse each backend's preset heading key, which the locales already translate. */
const SB_PRESET_ROW_TITLES = Object.freeze({
    'kobold_api-presets': ['Kobold Presets', 'kobldpresets'],
    'novel_api-presets': ['NovelAI Presets', 'novelaipresets'],
    'textgenerationwebui_api-presets': ['Text Completion Presets', 'Text Completion presets'],
    'openai_api-presets': ['Chat Completion Presets', 'openaipresets'],
});

const SB_PRESET_MENU_SECTIONS = Object.freeze([
    ['update', 'rename', 'new'],
    ['import', 'export', 'masterImport', 'masterExport'],
    ['restore', 'restoreDefaults'],
    ['delete', 'deleteAll'],
]);

const SB_EDITOR_UTILITY_PROMPT_IDS = Object.freeze([
    'impersonation_prompt_textarea', 'wi_format_textarea', 'scenario_format_textarea', 'personality_format_textarea',
    'group_nudge_prompt_textarea', 'newchat_prompt_textarea', 'newgroupchat_prompt_textarea',
    'newexamplechat_prompt_textarea', 'continue_nudge_prompt_textarea', 'send_if_empty_textarea',
]);

function getPresetActionKind(button) {
    if (!(button instanceof HTMLElement)) return null;
    for (const kind of ['import', 'export', 'update', 'rename', 'new', 'restore', 'delete']) {
        if (button.matches(`[data-preset-manager-${kind}]`)) return kind;
    }
    if (button.matches('[data-preset-manager-delete-all]')) {
        return 'deleteAll';
    }
    if (button.matches('[data-preset-manager-restore-defaults]')) {
        return 'restoreDefaults';
    }
    if (button.id === 'import_oai_preset') return 'import';
    if (button.id === 'export_oai_preset') return 'export';
    if (button.id === 'update_oai_preset') return 'update';
    if (button.id === 'new_oai_preset') return 'new';
    if (button.id === 'delete_oai_preset') return 'delete';
    return null;
}

/**
 * An ellipsis marks an action that asks for more input or a confirmation. PresetManager confirms
 * Update and downloads Export at once. Chat Completions saves Update at once and asks before it exports.
 */
function getPresetActionLabels(isChatCompletion) {
    return {
        update: isChatCompletion ? t`Update` : t`Update…`,
        rename: t`Rename…`,
        new: t`Save As…`,
        import: t`Import…`,
        export: isChatCompletion ? t`Export…` : t`Export`,
        masterImport: t`Master Import…`,
        masterExport: t`Master Export…`,
        restore: t`Restore…`,
        restoreDefaults: t`Restore Default Presets…`,
        delete: t`Delete…`,
        deleteAll: t`Delete in Bulk…`,
    };
}

/** Reads the live originals, so call it on every open: PresetManager adds its restore-defaults button late, and autosave marks Update read-only per preset. */
export function getPresetMenuSections(block, isChatCompletion, { master = true } = {}) {
    const originals = new Map();
    for (const button of block.querySelectorAll('.menu_button, .menu_button_icon')) {
        const kind = getPresetActionKind(button);
        if (kind && !originals.has(kind)) originals.set(kind, button);
    }
    if (!isChatCompletion && master) {
        originals.set('masterImport', document.getElementById('af_master_import'));
        originals.set('masterExport', document.getElementById('af_master_export'));
    }
    const labels = getPresetActionLabels(isChatCompletion);
    const toItem = kind => {
        const original = originals.get(kind);
        if (!(original instanceof HTMLElement)) return null;
        // An action that does not apply (a preset that cannot be updated) is left out, not drawn dimmed.
        const disabled = original.classList.contains('disabled')
            || original.hasAttribute('disabled')
            || original.getAttribute('aria-disabled') === 'true';
        if (disabled) return null;
        return {
            label: labels[kind],
            icon: original.querySelector('i')?.className,
            ...(kind.startsWith('master') ? { title: original.title } : {}),
            danger: kind === 'delete' || kind === 'deleteAll',
            onSelect: () => original.click(),
        };
    };
    return SB_PRESET_MENU_SECTIONS.map(kinds => ({ items: kinds.map(toItem).filter(Boolean) }));
}

function drawerHasControls(drawer) {
    if (!(drawer instanceof HTMLElement)) {
        return false;
    }

    const content = drawer.querySelector('.inline-drawer-content');
    if (!(content instanceof HTMLElement)) {
        return false;
    }

    return Boolean(content.querySelector([
        '.range-block',
        '[data-tg-samplers]',
        'select',
        'textarea',
        'button',
        '.menu_button',
        'input:not([type="hidden"])',
    ].join(',')));
}

export function hideEmptyGroupedSettingsDrawers() {
    // Flattened sections are skipped: they have no `.inline-drawer-content` left, so the control
    // test would report them empty and hide a section that only exists while expanded.
    document.querySelectorAll('#range_block_openai .sb-openai-settings-drawer, #textgenerationwebui_api-settings .sb-textgen-drawers > .inline-drawer').forEach(drawer => {
        if (!(drawer instanceof HTMLElement) || !drawer.classList.contains('inline-drawer')) {
            return;
        }

        drawer.style.display = drawerHasControls(drawer) ? '' : 'none';
    });
}

export function createBackendPanelsController({
    createElement,
    createBackendSectionHeader,
    createBackendGroupHeader,
    createBackendPromptGroup,
    getShellState,
    getCurrentMainApiValue,
    isShellTabOpen,
    openShell,
    getAppearanceModule,
    getBackendPagesModule,
    backendPagesContext,
    invalidateUserSettingsTabSearchIndexes,
    updateSamplingSectionVisibility,
}) {
    const sbPresetRows = [];

    function syncBackgroundSettingsSection() {
        const appearanceModule = getAppearanceModule();
        const appearance = document.getElementById(SB_USER_SETTINGS_CONTAINER_IDS.appearance);
        const gallery = document.getElementById('backgrounds-button');
        if (!appearanceModule || !(appearance instanceof HTMLElement) || !(gallery instanceof HTMLElement)) return;

        let section = appearance.querySelector('#sb-background-settings-section');
        let changed = false;
        if (!(section instanceof HTMLElement)) {
            const group = appearanceModule.createAppearanceGroup({
                id: 'background',
                elementId: 'sb-background-settings-section',
                title: 'Background',
                description: 'Choose backgrounds and adjust their size, blur, opacity, and visibility',
            });
            group.group.id = 'sb-background-settings-controls';
            const heading = group.section.querySelector('.ds-pref-group-heading');
            heading.id = 'sb-background-settings-heading';
            group.group.setAttribute('aria-labelledby', heading.id);
            section = group.section;
            appearance.append(section);
            changed = true;
        }

        const controls = section.querySelector('#sb-background-settings-controls');
        if (!(controls instanceof HTMLElement)) throw new Error('Missing Background settings control group.');

        // The gallery owns its toolbar and layout; the normalizer must not box it around another pill.
        if (gallery.dataset.sbPresentation !== 'manual') gallery.dataset.sbPresentation = 'manual';
        const fitting = appearanceModule.presentBackgroundGallery(gallery);
        if (fitting) {
            controls.append(fitting.row);
            changed = true;
        }
        // The fitting row and the gallery close the group; the slider rows, which Interface injects after the initial split, come before them.
        const closing = controls.querySelector(':scope > .ds-select-row') ?? (gallery.parentElement === controls ? gallery : null);
        // These rows are authored in three tabs.
        for (const id of ['background-blur-block', 'background-opacity-block', 'background_thumbnails_animation', 'sb-surface-transparency-input']) {
            const control = document.getElementById(id);
            const row = id === 'background_thumbnails_animation' && control instanceof HTMLInputElement
                ? appearanceModule.presentBackgroundSwitch(control)
                : control?.closest('.ds-row, .checkbox_label');
            if (!(row instanceof HTMLElement) || row.parentElement === controls) continue;
            controls.insertBefore(row, closing);
            changed = true;
        }

        if (gallery.parentElement !== controls) {
            controls.append(gallery);
            changed = true;
        }
        if (changed) invalidateUserSettingsTabSearchIndexes();
    }

    /**
     * Each backend's original preset select row, its buttons, the Chat Completions title card and Master
     * Import/Export stay in the document, hidden, because upstream binds every action to them and the
     * Preset Menu clicks them.
     */
    function mountPresetRows(root) {
        for (const blockId of new Set(Object.values(SB_PRESET_BLOCK_BY_API))) {
            const block = root.querySelector(`#${blockId}`);
            const select = block?.querySelector('select[data-preset-manager-for]');
            if (!(select instanceof HTMLSelectElement) || select.closest('[data-sb-preset-row]')) continue;
            // Read before createProfileRow adopts the select into the new row.
            const source = select.parentElement;
            const isChatCompletion = blockId === SB_PRESET_BLOCK_BY_API.openai;
            const title = translate(...SB_PRESET_ROW_TITLES[blockId]);
            const preset = createProfileRow({
                select,
                label: t`Preset`,
                field: `preset-${blockId}`,
                title,
                searchLabel: t`Search Presets`,
                searchPlaceholder: t`Search presets`,
                menuLabel: t`Preset Menu`,
                onMenu: trigger => openActionMenu({ trigger, title, sections: getPresetMenuSections(block, isChatCompletion) }),
            });
            preset.row.dataset.sbPresetRow = '';
            source.before(preset.row);
            source.hidden = true;
            sbPresetRows.push(preset);
        }
        const hidden = root.querySelector('#openai_api-presets > div > .standoutHeader');
        if (hidden instanceof HTMLElement && !hidden.hidden) hidden.hidden = true;
    }

    /** Keeps Edit Prompts and then the autosave switch directly below the active backend's preset block. */
    function placeSharedPresetControls(root, activeApi) {
        let anchor = document.getElementById(SB_PRESET_BLOCK_BY_API[activeApi] ?? '');
        if (!(anchor instanceof HTMLElement) || !root.contains(anchor)) return;
        for (const row of [root.querySelector('[data-sb-edit-prompts]'), root.querySelector('[data-sb-preset-autosave]')]) {
            if (!(row instanceof HTMLElement)) continue;
            // Moving a row that is already in place still queues a mutation, and the drawer observer re-runs this.
            if (anchor.nextElementSibling !== row) anchor.after(row);
            anchor = row;
        }
    }

    /**
     * Moves the Chat Completions linking switches out of their drawer in Presets into a group after it.
     * Each copy block moves whole: its copy line becomes the row subtitle only while it follows the label,
     * and toggle-dependent.css shows the profile buttons only while their container follows the label.
     */
    function mountPresetLinkingGroup(presetsContainer) {
        if (!(presetsContainer instanceof HTMLElement)) return;
        // The Prompting content is still detached from the document here, so document.getElementById() finds nothing.
        const blocks = ['bind_preset_to_connection', 'bind_preset_to_sampling', 'model_sampling_profiles_enabled']
            .map(id => presetsContainer.querySelector(`#${id}`)?.closest('.sb-setting-inline-copy'))
            .filter(block => block instanceof HTMLElement);
        const drawer = blocks[0]?.closest('.inline-drawer');
        if (!(drawer instanceof HTMLElement)) return;
        const group = createBackendPromptGroup('sb-preset-linking', 'Preset API/Sampler Linking');
        group.firstElementChild.replaceWith(createBackendGroupHeader('Preset API/Sampler Linking'));
        group.querySelector(':scope > .sb-prompting-group-body').append(...blocks);
        // The flatten pass would turn the emptied drawer into a headed section inside Presets.
        drawer.remove();
        presetsContainer.after(group);
    }

    function groupPromptingRowHelpers(root) {
        for (const row of root.querySelectorAll('.sb-prompting-group-body .ds-row')) {
            if (row.parentElement.matches('.sb-prompting-row-with-help') || row.closest('#completion_prompt_manager')) continue;
            const helpers = [];
            for (let helper = row.nextElementSibling; helper?.matches('.toggle-description, .notes, p, small'); helper = helper.nextElementSibling) {
                helpers.push(helper);
            }
            if (helpers.length === 0) continue;
            const wrapper = createElement('div', { className: 'sb-prompting-row-with-help' });
            row.before(wrapper);
            wrapper.append(row, ...helpers);
        }
    }

    function prepareEditorPanel(root) {
        if (!(root instanceof HTMLElement) || root.dataset.sbEditorPrepared === 'true') return;
        root.dataset.sbEditorPrepared = 'true';
        root.dataset.sbPresentation = 'manual';
        root.classList.add('sb-prompting-panel', 'sb-editor-panel');
        // The prompt list's header bar carries the presets, the backend, the way back to Presets and the two states, so the list starts under the page header.
        for (const [id, title] of [
            ['sb-editor-utility', 'Utility Prompts'],
            ['sb-editor-sysprompt', 'System Prompt'],
            ['sb-editor-instruct', 'Instruct Template'],
            ['sb-editor-context', 'Context Template'],
        ]) root.append(createBackendPromptGroup(id, title));
        initializePromptEditor(root, { openPresets: () => openShell('left', 'prompting') });
    }

    function updateEditorPanel(panel = getShellState('left')?.tabs.get('editor')?.panel) {
        const rawColumn = panel?.querySelector('.sb-editor-panel') ?? panel?.querySelector(':scope > .sb-shell-panel-scroller > .sb-shell-column');
        if (rawColumn instanceof HTMLElement) prepareEditorPanel(rawColumn);
        const root = panel?.querySelector('.sb-editor-panel');
        if (!(root instanceof HTMLElement)) return;
        const activeApi = getCurrentMainApiValue();
        const isChatCompletion = activeApi === 'openai';
        const backend = SB_BACKEND_TITLES.find(entry => entry.apiIds.includes(activeApi));
        const mode = root.querySelector('[data-sb-editor-mode]');
        const modeLabel = backend?.title ?? activeApi;
        if (mode && mode.textContent !== modeLabel) mode.textContent = modeLabel;

        const adoptDocument = (id, groupId, wrapperSelector = null) => {
            const field = document.getElementById(id);
            const body = root.querySelector(`#${groupId} > .sb-prompting-group-body`);
            if (!(field instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
            const documentNode = field.closest('[data-sb-editor-document]')
                ?? (wrapperSelector ? field.closest(wrapperSelector) : field.parentElement);
            if (!(documentNode instanceof HTMLElement)) return;
            if (documentNode.dataset.sbEditorDocument !== 'true') documentNode.dataset.sbEditorDocument = 'true';
            if (documentNode.parentElement !== body) body.append(documentNode);
        };

        const manager = document.getElementById('sb-openai-prompt-manager');
        if (manager instanceof HTMLElement) {
            if (manager.parentElement !== root || manager.previousElementSibling) root.prepend(manager);
            if (manager.style.display) manager.style.display = '';
            if (!manager.classList.contains('sb-prompting-group')) manager.classList.add('sb-prompting-group');
            // The flatten pass visits descendants, so include the group's outer drawer via its parent.
            flattenNestedSettingsDrawers(root, { includeTopLevel: true });
            let body = manager.querySelector(':scope > .sb-prompting-group-body');
            if (!(body instanceof HTMLElement)) {
                body = createElement('div', { className: 'ds-pref-group sb-prompting-group-body' });
                for (const child of [...manager.children]) {
                    if (!child.classList.contains('sb-settings-flat-header')) body.append(child);
                }
                manager.append(body);
            }
            const block = document.getElementById('completion_prompt_manager')?.closest('.range-block');
            if (block instanceof HTMLElement && !manager.contains(block)) body.append(block);
            if (manager.hidden === isChatCompletion) manager.hidden = !isChatCompletion;
        }
        for (const id of SB_EDITOR_UTILITY_PROMPT_IDS) adoptDocument(id, 'sb-editor-utility', '.range-block');
        for (const id of ['sysprompt_content', 'sysprompt_post_history']) adoptDocument(id, 'sb-editor-sysprompt');
        const sequences = document.getElementById('InstructSequencesColumn');
        const instructBody = root.querySelector('#sb-editor-instruct > .sb-prompting-group-body');
        if (sequences instanceof HTMLElement && sequences.parentElement !== instructBody) instructBody.append(sequences);
        for (const id of ['context_story_string', 'context_story_string_position', 'context_example_separator']) {
            adoptDocument(id, 'sb-editor-context', '[data-cc-null]');
        }
        for (const id of ['sb-editor-utility', 'sb-editor-sysprompt', 'sb-editor-instruct', 'sb-editor-context']) {
            const group = root.querySelector(`#${id}`);
            if (!(group instanceof HTMLElement)) continue;
            const hidden = (id === 'sb-editor-utility' ? !isChatCompletion : isChatCompletion)
                || !group.querySelector('textarea, select, input');
            if (group.hidden !== hidden) group.hidden = hidden;
        }
        root.querySelector('#sb-editor-sysprompt').classList.toggle('disabled', document.getElementById('SystemPromptBlock')?.classList.contains('disabled') ?? false);

        const selectedName = id => {
            const select = document.getElementById(id);
            return select instanceof HTMLSelectElement ? select.selectedOptions[0]?.textContent : null;
        };
        const presetNames = isChatCompletion
            ? [selectedName('settings_preset_openai')]
            : ['sysprompt_select', 'instruct_presets', 'context_presets'].map(id => {
                const title = ({ sysprompt_select: 'System Prompt', instruct_presets: 'Instruct Template', context_presets: 'Context Template' })[id];
                const name = selectedName(id);
                return name ? `${title}: ${name}` : null;
            });
        const names = presetNames.filter(Boolean).join(' · ');
        const meta = root.querySelector('[data-sb-editor-preset]');
        if (meta && meta.textContent !== names) meta.textContent = names;
        refreshPresetProtectionUi();
        for (const group of root.querySelectorAll('.sb-prompting-group:not(#sb-openai-prompt-manager)')) normalizeBackendSettingsRows(group);
        for (const wrapper of root.querySelectorAll('[data-sb-editor-document]:not(.ds-row):not(.sb-settings-row-wrapper)')) wrapper.classList.add('sb-settings-row-wrapper');
        groupPromptingRowHelpers(root);
        const tab = getShellState('left')?.tabs.get('editor');
        if (tab) tab.searchIndex = null;
    }

    function preparePromptingPanel(root) {
        if (!(root instanceof HTMLElement) || root.dataset.sbPromptingPrepared === 'true') return;
        root.dataset.sbPromptingPrepared = 'true';
        root.classList.add('sb-prompting-panel');
        root.dataset.sbPresentation = 'manual';
        const completionTabs = /** @type {{openAITabManager?: {refreshTabs: () => void}}|undefined} */ (window['ChatCompletionTabs']);
        completionTabs?.openAITabManager?.refreshTabs();
        const configuration = root.querySelector('#ai_response_configuration');
        if (!(configuration instanceof HTMLElement)) return;

        configuration.prepend(createBackendSectionHeader({ modeAttrs: { 'data-sb-prompting-mode': '' } }));
        const presetsContainer = configuration.querySelector('#respective-presets-block');

        for (const [id, title, description] of [
            ['respective-presets-block', 'Presets', 'Choose and manage presets for the current backend'],
            ['common-gen-settings-block', 'Generation Settings', 'Set context and reply limits, streaming, and other generation options'],
        ]) {
            const block = configuration.querySelector(`#${id}`);
            if (!(block instanceof HTMLElement)) continue;
            block.classList.add('sb-prompting-group');
            block.prepend(createBackendGroupHeader(title, {}, description));
            const body = createElement('div', { className: 'ds-pref-group sb-prompting-group-body' });
            for (const child of [...block.children].slice(1)) body.append(child);
            block.append(body);
        }
        const editPrompts = createButtonRow({
            label: t`Edit Prompts`,
            field: 'edit-prompts',
            arrow: true,
            onActivate: () => openShell('left', 'editor'),
        });
        editPrompts.row.dataset.sbEditPrompts = '';
        presetsContainer?.querySelector(':scope > .sb-prompting-group-body')?.append(editPrompts.row);
        mountPresetLinkingGroup(presetsContainer);
        const generation = configuration.querySelector('#pro-settings-block');
        if (generation instanceof HTMLElement) {
            for (const id of ['streaming_textgenerationwebui_block', 'streaming_kobold_block', 'streaming_novel_block']) {
                const streaming = configuration.querySelector(`#${id}`);
                if (streaming) generation.append(streaming);
            }
        }

        const createPromptingGroup = (id, title, description = '') => {
            const existing = configuration.querySelector(`#${CSS.escape(id)}`);
            if (existing instanceof HTMLElement) return existing;
            const group = createBackendPromptGroup(id, title);
            group.firstElementChild.replaceWith(createBackendGroupHeader(title, {}, description));
            configuration.append(group);
            return group;
        };

        for (const [id, title, description] of [
            ['sb-tc-sysprompt', 'System Prompt', 'Choose and manage system prompt presets'],
            ['sb-tc-instruct', 'Instruct Template', 'Choose an instruct template and adjust how it formats messages for the AI'],
            ['sb-tc-context', 'Context Template', 'Choose a context template and adjust its stopping rules'],
            ['sb-tc-names', 'Character Names', 'Choose whether to add the character\'s name outside Instruct Mode'],
            ['sb-reasoning-template', 'Reasoning Template', 'Saves the reasoning prefix, suffix and separator under a name'],
        ]) createPromptingGroup(id, title, description);

        // SillyBunny: keep range_block_openai around its groups for provider visibility and preset lookups.
        const range = configuration.querySelector('#range_block_openai');
        const advanced = configuration.querySelector('#advanced-ai-config-block');
        if (range instanceof HTMLElement && advanced instanceof HTMLElement) advanced.prepend(range);
        mountPresetRows(root);
    }

    function updateFormattingGroupVisibility(formatting) {
        if (!(formatting instanceof HTMLElement)) return;
        const groups = [...formatting.querySelectorAll('.sb-formatting-group')].filter(group => group instanceof HTMLElement);
        // Unhide every group first, then measure all, then write: one layout flush instead of one per group.
        for (const group of groups) {
            if (group.hidden) group.hidden = false;
        }
        const empty = groups.filter(group => ![...group.querySelectorAll('input, select, textarea, button, .menu_button')]
            .some(control => control instanceof HTMLElement && (control.checkVisibility?.() ?? control.getClientRects().length > 0)));
        for (const group of empty) group.hidden = true;
    }

    function updatePromptingPanel(panel) {
        if (!(panel instanceof HTMLElement)) return;
        const rawRoot = panel.querySelector('.sb-prompting-panel') ?? panel.querySelector(':scope > .sb-shell-panel-scroller > .sb-shell-column');
        if (rawRoot instanceof HTMLElement) preparePromptingPanel(rawRoot);
        groupAdvancedFormattingIntoDrawers();
        const root = panel.querySelector('.sb-prompting-panel');
        if (!(root instanceof HTMLElement)) return;
        const activeApi = getCurrentMainApiValue();
        const backend = SB_BACKEND_TITLES.find(entry => entry.apiIds.includes(activeApi));
        const mode = root.querySelector('[data-sb-prompting-mode]');
        const modeLabel = `Backend: ${backend?.title ?? activeApi}`;
        if (mode && mode.textContent !== modeLabel) mode.textContent = modeLabel;
        const bindModelPresetBlock = root.querySelector('[name="bindModelPresetBlock"]') ?? document.querySelector('[name="bindModelPresetBlock"]');
        if (bindModelPresetBlock instanceof HTMLElement && bindModelPresetBlock.hidden !== (activeApi === 'openai')) bindModelPresetBlock.hidden = activeApi === 'openai';

        flattenNestedSettingsDrawers(root, { includeTopLevel: true });
        updateEditorPanel();
        const range = root.querySelector('#range_block_openai');
        // SillyBunny: Quick Prompts remain mounted for upstream integrations; the Prompt Manager is their single editor.
        const quickPrompts = root.querySelector('#sb-openai-prompts');
        if (quickPrompts instanceof HTMLElement && !quickPrompts.hidden) quickPrompts.hidden = true;
        const reasoningBody = root.querySelector('#sb-reasoning-template > .sb-prompting-group-body');
        const reasoningDetails = document.getElementById('reasoning_select')?.closest('details');
        if (reasoningBody instanceof HTMLElement && reasoningDetails instanceof HTMLElement) {
            for (const child of [...reasoningDetails.children]) {
                if (child.tagName !== 'SUMMARY') reasoningBody.append(child);
            }
            if (!reasoningDetails.hidden) reasoningDetails.hidden = true;
        }
        const isChatCompletion = activeApi === 'openai';
        const promptingGroupIds = [
            'sb-openai-budget', 'sb-openai-sampling', 'sb-openai-names', 'sb-openai-prefill',
            'sb-openai-request',
            'sb-tc-sysprompt', 'sb-tc-instruct', 'sb-tc-context', 'sb-tc-names',
        ];
        for (const id of promptingGroupIds) {
            const group = root.querySelector(`#${id}`);
            if (!(group instanceof HTMLElement)) continue;
            if (id.startsWith('sb-openai-') && range instanceof HTMLElement && group.parentElement !== range) range.append(group);
            group.classList.toggle('sb-prompting-group', true);
            if (id === 'sb-openai-budget') {
                const title = group.querySelector('.sb-settings-flat-header :is(b, h3)');
                if (title && title.textContent !== 'Generation Settings') title.textContent = 'Generation Settings';
            }
            if (!group.querySelector(':scope > .sb-prompting-group-body')) {
                const body = createElement('div', { className: 'ds-pref-group sb-prompting-group-body' });
                for (const child of [...group.children]) {
                    if (!child.classList.contains('sb-settings-flat-header')) body.append(child);
                }
                group.append(body);
            }
            normalizeBackendSettingsRows(group);
            const isTcGroup = id.startsWith('sb-tc-');
            const isCcGroup = id.startsWith('sb-openai-');
            const hidden = id === 'sb-openai-sampling' || (isTcGroup ? isChatCompletion : isCcGroup ? !isChatCompletion : false);
            if (group.hidden !== hidden) group.hidden = hidden;
        }
        // SillyBunny: the Prompt Manager may mount late, so restore the complete Chat Completions order on every update.
        if (range instanceof HTMLElement) {
            // SillyBunny: the Presets module adds the groups for the choice sets and the dependent sets between the upstream ones.
            const openAIReadingOrder = [
                'sb-openai-budget', 'sb-openai-names-behavior', 'sb-openai-continue-postfix', 'sb-openai-names', 'sb-openai-prefill', 'sb-openai-request',
                'sb-openai-function-calling', 'sb-openai-inline-media', 'sb-openai-request-images', 'sb-openai-request-reasoning', 'sb-openai-reasoning-tags',
                'sb-openai-prompt-caching',
            ];
            const orderedGroups = openAIReadingOrder
                .map(id => root.querySelector(`#${id}`))
                .filter(group => group instanceof HTMLElement);
            const currentTail = Array.from(range.children).slice(-orderedGroups.length);
            const isOrdered = orderedGroups.length > 0
                && currentTail.length === orderedGroups.length
                && currentTail.every((child, index) => child === orderedGroups[index]);

            if (!isOrdered) {
                for (const group of orderedGroups) range.append(group);
            }
        }

        const tcOrder = ['sb-tc-sysprompt', 'sb-tc-instruct', 'sb-tc-context', 'sb-tc-names'];
        const commonGroup = root.querySelector('#common-gen-settings-block');
        if (commonGroup instanceof HTMLElement) {
            let anchor = commonGroup;
            for (const id of tcOrder) {
                const group = root.querySelector(`#${id}`);
                if (!(group instanceof HTMLElement)) continue;
                if (group.parentElement !== anchor.parentElement || group.previousElementSibling !== anchor) {
                    anchor.after(group);
                }
                anchor = group;
            }
        }
        const reasoning = root.querySelector('#sb-reasoning-template');
        const configuration = root.querySelector('#ai_response_configuration');
        if (reasoning instanceof HTMLElement && configuration instanceof HTMLElement && configuration.lastElementChild !== reasoning) configuration.append(reasoning);
        if (reasoning instanceof HTMLElement) normalizeBackendSettingsRows(reasoning);

        // SillyBunny: the multiple-swipes control is authored as a data-tg-samplers wrapper,
        // not a range-block. Move only that wrapper into the shared Generation Settings group.
        const textgenSwipes = document.getElementById('n_textgenerationwebui')?.closest('[data-tg-samplers="n"]');
        const generationBody = root.querySelector('#common-gen-settings-block > .sb-prompting-group-body');
        if (textgenSwipes instanceof HTMLElement && generationBody instanceof HTMLElement && textgenSwipes.parentElement !== generationBody) {
            generationBody.append(textgenSwipes);
        }
        const presets = root.querySelector('#respective-presets-block');
        const presetsBody = presets?.querySelector(':scope > .sb-prompting-group-body');
        if (presetsBody instanceof HTMLElement && !presetsBody.querySelector('[data-sb-preset-autosave]')) {
            presetsBody.append(createPresetAutosaveToggle());
        }
        placeSharedPresetControls(root, activeApi);
        // Upstream sets some preset selects without a change event, for example when it restores the selection after a source change.
        for (const preset of sbPresetRows) preset.sync();
        if (presets instanceof HTMLElement) normalizeBackendSettingsRows(presets);
        const common = root.querySelector('#common-gen-settings-block');
        if (common instanceof HTMLElement) {
            const contextRow = common.querySelector('#max_context_block');
            const quickContext = contextRow?.querySelector('.quick_context_size_container');
            if (quickContext && contextRow && contextRow.nextElementSibling !== quickContext) contextRow.after(quickContext);
            normalizeBackendSettingsRows(common);
        }
        normalizeBackendSettingsRows(root, { fields: false });
        hideEmptyGroupedSettingsDrawers();
        groupPromptingRowHelpers(root);
        getBackendPagesModule()?.presentPresets(backendPagesContext);
        // Batch writes and reads: interleaving `hidden` writes with checkVisibility() forces a style and
        // layout flush per group, which is what made opening Prompting drop frames on slower devices.
        const measured = [];
        for (const group of root.querySelectorAll('.sb-openai-settings-drawer, .sb-textgen-drawers > .sb-settings-flat-section, .sb-prompting-group')) {
            if (!(group instanceof HTMLElement)) continue;
            const shouldHideByMode = ['sb-openai-sampling', 'sb-openai-prompts'].includes(group.id)
                || (group.id.startsWith('sb-openai-') && !isChatCompletion)
                || (group.id.startsWith('sb-tc-') && isChatCompletion)
                || (group.id === 'sb-preset-linking' && !isChatCompletion);
            // The text-generation sampling sections are source containers for the separate Sampling tab,
            // not Prompting content; only their live controls belong in the sampling cards.
            const isSamplingSourceGroup = group.matches('.sb-textgen-drawers > .sb-settings-flat-section');
            const hidesWhenEmpty = group.id.startsWith('sb-openai-') || group.id.startsWith('sb-tc-');
            const hidden = shouldHideByMode || isSamplingSourceGroup;
            if (group.hidden !== hidden) group.hidden = hidden;
            if (hidesWhenEmpty && !hidden) measured.push(group);
        }
        const emptyGroups = measured.filter(group => ![...group.querySelectorAll('input:not([type="hidden"]), select, textarea, button, .menu_button')]
            .some(control => control instanceof HTMLElement && (control.checkVisibility?.() ?? control.getClientRects().length > 0)));
        for (const group of emptyGroups) group.hidden = true;
        const tab = getShellState('left')?.tabs.get('prompting');
        if (tab) tab.searchIndex = null;
    }

    function groupAdvancedFormattingIntoDrawers() {
        const formatting = document.getElementById('AdvancedFormatting');
        if (!(formatting instanceof HTMLElement)) return;
        const promptingTab = getShellState('left')?.tabs.get('prompting');
        const promptingRoot = promptingTab?.panel?.querySelector('.sb-prompting-panel')
            ?? promptingTab?.panel?.querySelector(':scope > .sb-shell-panel-scroller > .sb-shell-column');
        if (promptingRoot instanceof HTMLElement) preparePromptingPanel(promptingRoot);

        const groupOrder = ['sb-af-tokenizer', 'sb-af-stopping', 'sb-af-reply-prefix', 'sb-af-cleanup', 'sb-af-reasoning', 'sb-af-reasoning-prompts', 'sb-af-rendering', 'sb-af-advanced'];
        const orderGroups = () => {
            const groups = groupOrder.map(id => formatting.querySelector(`#${id}`)).filter(group => group instanceof HTMLElement);
            const currentGroups = [...formatting.children].filter(child => child.classList.contains('sb-formatting-group'));
            if (groups.length === currentGroups.length && groups.every((group, index) => group === currentGroups[index])) return;
            for (const group of groups) formatting.append(group);
        };
        if (formatting.dataset.sbGrouped === 'true') {
            const replyPrefixBody = formatting.querySelector('#sb-af-reply-prefix > .sb-prompting-group-body');
            const startReplyWith = formatting.querySelector('[name="startReplyWithBlock"]');
            if (startReplyWith instanceof HTMLElement && replyPrefixBody instanceof HTMLElement && startReplyWith.parentElement !== replyPrefixBody && !startReplyWith.dataset.sbEmptiedByOrder) {
                startReplyWith.hidden = false;
                replyPrefixBody.append(startReplyWith);
            }
            orderGroups();
            if (isShellTabOpen('left', 'context')) updateFormattingGroupVisibility(formatting);
            return;
        }

        const columns = formatting.querySelector('.flex-container.spaceEvenly');
        const contextColumn = formatting.querySelector('#ContextSettings');
        const instructColumn = formatting.querySelector('#InstructSettingsColumn');
        const systemColumn = formatting.querySelector('#SystemPromptColumn');
        if (!(columns instanceof HTMLElement) || !(contextColumn instanceof HTMLElement)
            || !(instructColumn instanceof HTMLElement) || !(systemColumn instanceof HTMLElement)) return;

        const startReplyWith = systemColumn.querySelector('[name="startReplyWithBlock"]');

        const createGroup = (id, title, description) => {
            const group = createElement('section', { id, className: 'sb-prompting-group sb-formatting-group sb-settings-category' });
            if (!description) group.dataset.sbDescription = 'none';
            group.append(
                createBackendGroupHeader(title, { 'data-i18n': title }, description),
                createElement('div', { className: 'ds-pref-group sb-prompting-group-body sb-settings-category-body' }),
            );
            formatting.append(group);
            return group.querySelector('.sb-prompting-group-body');
        };
        const bodies = new Map([
            ['tokenizer', createGroup('sb-af-tokenizer', 'Tokenizer & Padding', 'Choose a tokenizer and adjust prompt token counts with padding')],
            ['stopping', createGroup('sb-af-stopping', 'Stopping Strings', 'Choose text that stops generation, with optional macro replacement')],
            ['reply-prefix', createGroup('sb-af-reply-prefix', 'Reply Prefix', 'Set how replies begin and whether that text appears in chat')],
            ['cleanup', createGroup('sb-af-cleanup', 'Text Cleanup', 'Control line breaks, extra spaces, and unfinished sentences in replies')],
            // SillyBunny: the caption of the Reasoning group says that its settings are global.
            ['reasoning', createGroup('sb-af-reasoning', 'Reasoning', 'These settings apply to every chat, whichever template is chosen')],
            ['reasoning-prompts', createGroup('sb-af-reasoning-prompts', 'Add to Prompts')],
            ['rendering', createGroup('sb-af-rendering', 'Rendering', 'Keep specified standalone text from being treated as Markdown')],
            // SillyBunny: the upstream page heading, its documentation link and Master Import/Export are this group (filled by sillybunny-backend-pages.js).
            ['advanced', createGroup('sb-af-advanced', 'Advanced Formatting')],
        ]);

        // SillyBunny: a block that the Formatting and Presets rows emptied stays out of the box it came from.
        const move = (target, body) => {
            if (!(target instanceof HTMLElement) || !(body instanceof HTMLElement) || target.dataset.sbEmptiedByOrder) return;
            body.append(target);
        };
        const moveClosest = (selector, body, ancestorSelector = null) => {
            const target = formatting.querySelector(selector);
            if (!(target instanceof HTMLElement)) return;
            const resolved = ancestorSelector ? target.closest(ancestorSelector) : target;
            move(resolved, body);
        };

        const prompting = promptingTab?.panel;
        const promptingGroupBody = id => prompting?.querySelector(`#${id} > .sb-prompting-group-body`);
        const moveToPrompting = (selector, id, ancestorSelector = null) => {
            const target = formatting.querySelector(selector);
            const body = promptingGroupBody(id);
            if (!(target instanceof HTMLElement) || !(body instanceof HTMLElement)) return;
            move(ancestorSelector ? target.closest(ancestorSelector) : target, body);
        };

        const groupBody = id => promptingGroupBody(id);
        const movePromptingNode = (node, id) => {
            const body = groupBody(id);
            if (node instanceof HTMLElement && body instanceof HTMLElement && node.parentElement !== body && !node.dataset.sbEmptiedByOrder) body.append(node);
        };

        moveToPrompting('[name="bindModelPresetBlock"]', 'respective-presets-block');
        document.querySelectorAll('.sb-sampling-section').forEach(section => updateSamplingSectionVisibility?.(section));
        const systemPromptBlock = systemColumn.querySelector('#SystemPromptBlock');
        movePromptingNode(systemColumn.querySelector(':scope > .title_restorable[data-cc-null]'), 'sb-tc-sysprompt');
        movePromptingNode(systemPromptBlock, 'sb-tc-sysprompt');
        moveToPrompting('#InstructSettingsColumn', 'sb-tc-instruct');
        movePromptingNode(contextColumn.querySelector(':scope > div > .title_restorable'), 'sb-tc-context');
        movePromptingNode(contextColumn.querySelector(':scope > div > .flex-container.flexNoGap'), 'sb-tc-context');
        const storyBlock = formatting.querySelector('[data-cc-null]:has(#context_story_string)');
        const contextBody = promptingGroupBody('sb-tc-context');
        if (storyBlock instanceof HTMLElement && contextBody instanceof HTMLElement) move(storyBlock, contextBody);
        movePromptingNode(contextColumn.querySelector(':scope > div > div > .flex-container.flexFlowColumn[data-cc-null]'), 'sb-tc-context');
        movePromptingNode(contextColumn.querySelector(':scope > div > div > .flex-container[data-cc-null]'), 'sb-tc-context');
        movePromptingNode(contextColumn.querySelector('#context_use_stop_strings')?.closest('label'), 'sb-tc-context');
        movePromptingNode(contextColumn.querySelector('#context_names_as_stop_strings')?.closest('label'), 'sb-tc-context');
        movePromptingNode(contextColumn.querySelector('#always-force-name2-checkbox')?.closest('label'), 'sb-tc-names');
        moveClosest('[name="tokenizerSettingsBlock"]', bodies.get('tokenizer'));
        moveClosest('div[data-cc-null][data-cc-chat-completion-visible]', bodies.get('stopping'));
        if (startReplyWith instanceof HTMLElement && !startReplyWith.dataset.sbEmptiedByOrder) {
            startReplyWith.hidden = false;
            move(startReplyWith, bodies.get('reply-prefix'));
        }
        moveClosest('#single_line', bodies.get('cleanup'), 'label');
        moveClosest('#collapse-newlines-checkbox', bodies.get('cleanup'), 'label');
        moveClosest('#trim_spaces', bodies.get('cleanup'), 'label');
        moveClosest('#trim_sentences_checkbox', bodies.get('cleanup'), 'label');
        const cleanupHeading = [...contextColumn.querySelectorAll('h4.standoutHeader')]
            .find(heading => heading.textContent?.includes('Context Formatting'));
        cleanupHeading?.setAttribute('hidden', '');
        const reasoningWrapper = systemColumn.querySelector('div:has(.sb-reasoning-toggle-grid)');
        if (reasoningWrapper instanceof HTMLElement) move(reasoningWrapper, bodies.get('reasoning'));
        const renderingControl = formatting.querySelector('#markdown_escape_strings')?.parentElement?.parentElement;
        if (renderingControl instanceof HTMLElement) move(renderingControl, bodies.get('rendering'));

        const miscHeading = [...systemColumn.querySelectorAll('h4')].find(heading => heading.textContent?.trim() === 'Miscellaneous');
        if (miscHeading instanceof HTMLElement) miscHeading.hidden = true;
        // `.flex-container` sets `display: flex`, which outranks `[hidden]`, so the emptied row of columns would stay in the
        // page's flex column as a zero-height item and add one gap above the first group. The marker is what the stylesheet hides.
        columns.hidden = true;
        columns.dataset.sbEmptiedByOrder = 'true';
        formatting.dataset.sbGrouped = 'true';
        orderGroups();
        updateFormattingGroupVisibility(formatting);
        // Normalize switch semantics for Formatting groups without restructuring.
        for (const body of bodies.values()) {
            normalizeBackendSettingsRows(body, { fields: false });
        }

        updateEditorPanel();
        updatePromptingPanel(prompting);
    }

    return {
        syncBackgroundSettingsSection,
        prepareEditorPanel,
        updateEditorPanel,
        preparePromptingPanel,
        updatePromptingPanel,
        groupAdvancedFormattingIntoDrawers,
        updateFormattingGroupVisibility,
        getPresetMenuSections,
        hideEmptyGroupedSettingsDrawers,
    };
}
