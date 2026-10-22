import { t } from '../../i18n.js';
import { registerSidePanel } from '../side-panel.js';
import { createCheckRow, createComboRow, createEntryRow, createPrefGroup, createRow, createSpinRow, createSwitchRow } from '../rows.js';
import { createToggleRow } from '../toggle-row.js';

const controllers = new Map();
const positionRefreshers = new Map();

function requireElement(root, selector, description) {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
        throw new TypeError(`The ${description} side panel needs ${selector}.`);
    }
    return element;
}

function requireInput(root, selector, type, description) {
    const input = root.querySelector(selector);
    if (!(input instanceof HTMLInputElement) || input.type !== type) {
        throw new TypeError(`The ${description} side panel needs an input[type="${type}"] at ${selector}.`);
    }
    return input;
}

function setRowLabel(row, key) {
    const label = row.querySelector('.ds-row-label');
    if (!label) throw new TypeError(`The ${key} side-panel row needs a label.`);
    label.dataset.i18n = key;
}

function listenForChange(input, listener) {
    const jquery = globalThis.jQuery ?? globalThis.$;
    if (typeof jquery === 'function') {
        jquery(input).on('change', listener);
        return;
    }
    input.addEventListener('change', listener);
}

function createTextareaRow(input, label, field) {
    const row = createEntryRow({ label, field, input });
    row.row.classList.add('ds-row--stacked', 'sb-side-panel__textarea-row');
    return row.row;
}

function createSectionGroup({ title, titleKey, titleId, field, rows, description = null }) {
    const group = createPrefGroup({ title, field, rows });
    const heading = group.section.querySelector('.ds-pref-group-heading');
    if (!heading) throw new TypeError(`The ${field} side-panel group needs a heading.`);
    heading.dataset.i18n = titleKey;
    if (titleId) heading.id = titleId;
    if (description instanceof HTMLElement) {
        const header = group.section.querySelector('.ds-pref-group-header');
        description.className = 'ds-pref-group-subtitle';
        header.append(description);
    }
    return group.section;
}

function transferSectionHeader(group, toggle) {
    const sourceTitle = toggle.querySelector('[data-i18n]');
    const heading = group.querySelector('.ds-pref-group-heading');
    if (sourceTitle && heading) heading.dataset.i18n = sourceTitle.dataset.i18n;
    if (toggle.id && heading) heading.id = toggle.id;

    const description = toggle.querySelector('small[data-i18n]');
    if (description && group instanceof HTMLElement) {
        description.className = 'ds-pref-group-subtitle';
        group.querySelector('.ds-pref-group-header')?.append(description);
    }
}

function getSectionParts(container, description) {
    const drawer = container.matches('.inline-drawer') ? container : container.querySelector(':scope > .inline-drawer');
    const toggle = drawer?.querySelector(':scope > .inline-drawer-toggle');
    const content = drawer?.querySelector(':scope > .inline-drawer-content');
    if (!(toggle instanceof HTMLElement) || !(content instanceof HTMLElement)) {
        throw new TypeError(`The ${description} side panel section needs its source drawer.`);
    }
    return { toggle, content };
}

function createPositionRow({
    root,
    field,
    radioName,
    depthId,
    roleId,
}) {
    const radios = [...root.querySelectorAll(`input[type="radio"][name="${radioName}"]`)];
    if (radios.length !== 3) throw new TypeError(`The ${field} side-panel position needs three source radios.`);

    const depthInput = requireInput(root, `#${depthId}`, 'number', field);
    const roleSelect = requireElement(root, `#${roleId}`, field);
    if (!(roleSelect instanceof HTMLSelectElement)) throw new TypeError(`The ${field} side panel needs a role select.`);

    const selectedRadio = radios.find(input => input.checked) ?? radios[0];
    const choices = [
        ['2', t`Before`],
        ['0', t`After`],
        ['1', t`In-chat @ Depth`],
    ];
    const positionInputs = choices.map(([value]) => {
        const input = radios.find(radio => radio.value === value);
        if (!input) throw new TypeError(`The ${field} side-panel position is missing value ${value}.`);
        return input;
    });
    const position = createToggleRow({
        label: t`Position`,
        field: `${field}-position`,
        choices,
        value: selectedRadio.value,
        fill: true,
        inputs: positionInputs,
    });
    setRowLabel(position.row, 'Position');

    const depth = createSpinRow({ label: t`Depth`, field: `${field}-depth`, input: depthInput, normalize: false });
    setRowLabel(depth.row, 'Depth');
    const role = createComboRow({ label: t`Role`, field: `${field}-role`, select: roleSelect });
    setRowLabel(role.row, 'Role');

    const refresh = () => {
        const selected = radios.find(input => input.checked) ?? radios[0];
        const isDepthPosition = selected.value === '1';
        position.setValue(selected.value);
        depth.setVisible(isDepthPosition);
        role.setVisible(isDepthPosition);
    };
    radios.forEach(input => listenForChange(input, refresh));
    refresh();

    return { position, depth, role, refresh };
}

function createAuthorNoteSection({ title, titleKey, field, container, rows, description }) {
    const { toggle } = getSectionParts(container, field);
    const group = createSectionGroup({ title, titleKey, titleId: toggle.id, field, rows, description });
    transferSectionHeader(group, toggle);
    return group;
}

function createAuthorNoteFrequencyRow(root, inputId, field) {
    const input = requireInput(root, `#${inputId}`, 'number', field);
    const sourceLabel = input.parentElement.querySelector('label');
    const subtitle = sourceLabel?.querySelector('small')?.textContent.trim();
    const row = createSpinRow({
        label: t`Insertion Frequency`,
        subtitle,
        field,
        input,
        normalize: false,
    });
    setRowLabel(row.row, 'Insertion Frequency');
    const subtitleNode = row.row.querySelector('.ds-row-subtitle');
    if (subtitleNode) subtitleNode.dataset.i18n = '(0 = Disable, 1 = Always)';
    return row.row;
}

function createAuthorNoteStatusRow(root) {
    const counter = requireElement(root, '#extension_floating_counter', 'Author\'s Note');
    return createRow({
        label: t`User inputs until next insertion:`,
        field: 'authors-note-next-insertion',
        suffix: counter,
    }).row;
}

function adaptAuthorNote(root) {
    if (root.dataset.sbSidePanelAdapter === 'authors-note') return;
    const holder = requireElement(root, '[name="floatingPromptHolder"]', 'Author\'s Note');
    const mainContainer = holder.querySelector(':scope > .inline-drawer');
    const characterContainer = holder.querySelectorAll(':scope > .inline-drawer')[1];
    const defaultContainer = holder.querySelectorAll(':scope > .inline-drawer')[2];
    if (![mainContainer, characterContainer, defaultContainer].every(element => element instanceof HTMLElement)) {
        throw new TypeError('The Author\'s Note side panel needs its three source sections.');
    }

    const mainParts = getSectionParts(holder, 'Author\'s Note');
    const mainPrompt = requireElement(holder, '#extension_floating_prompt', 'Author\'s Note');
    if (!(mainPrompt instanceof HTMLTextAreaElement)) throw new TypeError('The Author\'s Note prompt must be a textarea.');
    const mainCounter = requireElement(holder, '#extension_floating_prompt_token_counter', 'Author\'s Note');
    const scanInput = requireInput(holder, '#extension_floating_allow_wi_scan', 'checkbox', 'Author\'s Note');
    const mainDepth = createPositionRow({
        root: holder,
        field: 'authors-note-main',
        radioName: 'extension_floating_position',
        depthId: 'extension_floating_depth',
        roleId: 'extension_floating_role',
    });
    const scanRow = createSwitchRow({
        label: t`Include in World Info Scanning`,
        field: 'authors-note-world-info-scan',
        input: scanInput,
    });
    setRowLabel(scanRow.row, 'Include in World Info Scanning');
    const mainTextareaRow = createTextareaRow(mainPrompt, t`Author's Note`, 'authors-note-prompt');
    mainTextareaRow.append(mainCounter);
    const mainDescription = mainParts.content.querySelector('small');
    const mainGroup = createAuthorNoteSection({
        title: t`Author's Note`,
        titleKey: 'Author\'s Note',
        field: 'authors-note-main',
        container: mainContainer,
        description: mainDescription,
        rows: [
            mainTextareaRow,
            scanRow.row,
            mainDepth.position.row,
            mainDepth.depth.row,
            mainDepth.role.row,
            createAuthorNoteFrequencyRow(holder, 'extension_floating_interval', 'authors-note-frequency'),
            createAuthorNoteStatusRow(holder),
        ],
    });

    const characterParts = getSectionParts(characterContainer, 'Character Author\'s Note');
    const characterPrompt = requireElement(holder, '#extension_floating_chara', 'Character Author\'s Note');
    if (!(characterPrompt instanceof HTMLTextAreaElement)) throw new TypeError('The character Author\'s Note prompt must be a textarea.');
    const characterCounter = requireElement(holder, '#extension_floating_chara_token_counter', 'Character Author\'s Note');
    const useCharacterInput = requireInput(holder, '#extension_use_floating_chara', 'checkbox', 'Character Author\'s Note');
    const characterPositionInputs = [...characterParts.content.querySelectorAll('input[type="radio"][name="extension_floating_char_position"]')];
    if (characterPositionInputs.length !== 3) throw new TypeError('The character Author\'s Note section needs three source position radios.');
    const characterPosition = createToggleRow({
        label: t`Position`,
        field: 'authors-note-character-position',
        choices: [
            [0, t`Replace Author's Note`],
            [1, t`Top of Author's Note`],
            [2, t`Bottom of Author's Note`],
        ],
        value: Number(characterPositionInputs.find(input => input.checked)?.value ?? 0),
        fill: true,
        inputs: characterPositionInputs,
    });
    setRowLabel(characterPosition.row, 'Position');
    const characterSwitch = createSwitchRow({
        label: t`Use character author's note`,
        field: 'authors-note-use-character',
        input: useCharacterInput,
    });
    setRowLabel(characterSwitch.row, 'Use character author\'s note');
    const characterTextareaRow = createTextareaRow(characterPrompt, t`Character Author's Note (Private)`, 'authors-note-character-prompt');
    characterTextareaRow.append(characterCounter);
    const characterGroup = createAuthorNoteSection({
        title: t`Character Author's Note (Private)`,
        titleKey: 'Character Author\'s Note (Private)',
        field: 'authors-note-character',
        container: characterContainer,
        description: characterParts.content.querySelector('small[data-i18n]'),
        rows: [characterTextareaRow, characterSwitch.row, characterPosition.row],
    });

    const defaultParts = getSectionParts(defaultContainer, 'Default Author\'s Note');
    const defaultPrompt = requireElement(holder, '#extension_floating_default', 'Default Author\'s Note');
    if (!(defaultPrompt instanceof HTMLTextAreaElement)) throw new TypeError('The default Author\'s Note prompt must be a textarea.');
    const defaultCounter = requireElement(holder, '#extension_floating_default_token_counter', 'Default Author\'s Note');
    const defaultPosition = createPositionRow({
        root: holder,
        field: 'authors-note-default',
        radioName: 'extension_default_position',
        depthId: 'extension_default_depth',
        roleId: 'extension_default_role',
    });
    const defaultTextareaRow = createTextareaRow(defaultPrompt, t`Default Author's Note`, 'authors-note-default-prompt');
    defaultTextareaRow.append(defaultCounter);
    const defaultGroup = createAuthorNoteSection({
        title: t`Default Author's Note`,
        titleKey: 'Default Author\'s Note',
        field: 'authors-note-default',
        container: defaultContainer,
        description: defaultParts.content.querySelector('small'),
        rows: [
            defaultTextareaRow,
            defaultPosition.position.row,
            defaultPosition.depth.row,
            defaultPosition.role.row,
            createAuthorNoteFrequencyRow(holder, 'extension_default_interval', 'authors-note-default-frequency'),
        ],
    });

    holder.classList.remove('scrollY');
    holder.replaceChildren(mainGroup, characterGroup, defaultGroup);
    root.classList.remove('inline-drawer', 'flexGap5');
    root.dataset.sbSidePanelAdapter = 'authors-note';
    return [mainDepth, defaultPosition];
}

export function registerAuthorsNotePanel(element = document.getElementById('floatingPrompt')) {
    if (!(element instanceof HTMLElement)) throw new TypeError('The Author\'s Note side panel element is required.');
    if (controllers.has('floatingPrompt')) return controllers.get('floatingPrompt');
    const positions = adaptAuthorNote(element);
    const controller = registerSidePanel({ id: 'floatingPrompt', element, title: t`Author's Note`, defaultSide: 'left' });
    controllers.set('floatingPrompt', controller);
    positionRefreshers.set('floatingPrompt', () => positions.forEach(position => position.refresh()));
    return controller;
}

export function toggleAuthorsNotePanel(opener = document.activeElement) {
    const controller = controllers.get('floatingPrompt');
    if (!controller) throw new Error('Author\'s Note side panel has not been registered.');
    return controller.isOpen ? controller.close() : controller.open({ opener });
}

export function closeAuthorsNotePanel(options) {
    return controllers.get('floatingPrompt')?.close(options) ?? false;
}

export function refreshAuthorsNotePanel() {
    positionRefreshers.get('floatingPrompt')?.();
}

function createCfgSliderRow(root, id, field) {
    const range = requireInput(root, `#${id}`, 'range', 'CFG');
    const counter = requireInput(root, `#${id}_counter`, 'number', 'CFG');
    const sourceLabel = root.querySelector(`label[for="${id}"]`);
    if (!(sourceLabel instanceof HTMLLabelElement)) throw new TypeError(`The CFG side panel needs a label for #${id}.`);

    const row = document.createElement('div');
    row.className = 'ds-row ds-row-slider sb-side-panel__slider';
    row.dataset.sbEditorField = field;
    const text = document.createElement('span');
    text.className = 'ds-row-text';
    const label = document.createElement('label');
    label.className = 'ds-row-label';
    label.dataset.i18n = 'Scale';
    label.htmlFor = range.id;
    label.textContent = t`Scale`;
    const subtitle = sourceLabel.querySelector('small');
    if (subtitle) {
        subtitle.className = 'ds-row-subtitle';
        subtitle.dataset.i18n = '1 = disabled';
    }
    text.append(label);
    if (subtitle) text.append(subtitle);
    const suffix = document.createElement('span');
    suffix.className = 'ds-row-suffix';
    suffix.append(range, counter);
    row.append(text, suffix);

    counter.addEventListener('change', () => {
        if (!counter.value || !counter.validity.valid) {
            counter.value = range.value;
            return;
        }
        range.value = counter.value;
        counter.value = range.value;
        range.dispatchEvent(new Event('input', { bubbles: true }));
    });
    range.addEventListener('input', () => { counter.value = range.value; });
    return row;
}

function createCfgTextareaRow(root, id, labelKey, field) {
    const textarea = requireElement(root, `#${id}`, 'CFG');
    if (!(textarea instanceof HTMLTextAreaElement)) throw new TypeError(`The CFG side panel needs a textarea at #${id}.`);
    const sourceLabel = root.querySelector(`label[for="${id}"] [data-i18n="${labelKey}"]`);
    const row = createTextareaRow(textarea, sourceLabel?.textContent.trim() ?? labelKey, field);
    setRowLabel(row, labelKey);
    return row;
}

function createCfgSection({ container, title, titleKey, field, rows, description }) {
    const { toggle } = getSectionParts(container, 'CFG');
    const group = createSectionGroup({ title, titleKey, titleId: toggle.id, field, rows, description });
    transferSectionHeader(group, toggle);
    container.replaceChildren(group);
    return group;
}

function adaptCfg(root) {
    if (root.dataset.sbSidePanelAdapter === 'cfg') return;
    const chatContainer = requireElement(root, '#chat_cfg_container', 'CFG');
    const characterContainer = requireElement(root, '#chara_cfg_container', 'CFG');
    const globalContainer = requireElement(root, '#global_cfg_container', 'CFG');
    const cascadingContainer = requireElement(root, '#cfg_prompt_combine_container', 'CFG');

    const chatParts = getSectionParts(chatContainer, 'CFG chat');
    const chatUseCharacter = requireElement(root, '#groupchat_cfg_use_chara_container', 'CFG');
    const chatUseCharacterInput = requireInput(root, '#groupchat_cfg_use_chara', 'checkbox', 'CFG');
    const chatUseCharacterRow = createSwitchRow({ label: t`Use character CFG scales`, field: 'cfg-chat-use-character', input: chatUseCharacterInput });
    setRowLabel(chatUseCharacterRow.row, 'Use character CFG scales');
    chatUseCharacter.replaceChildren(chatUseCharacterRow.row);
    const chatDescription = chatParts.content.querySelector('small');
    createCfgSection({
        container: chatContainer,
        title: t`Chat CFG`,
        titleKey: 'Chat CFG',
        field: 'cfg-chat',
        description: chatDescription,
        rows: [
            createCfgSliderRow(root, 'chat_cfg_guidance_scale', 'cfg-chat-scale'),
            createCfgTextareaRow(root, 'chat_cfg_negative_prompt', 'Negative Prompt', 'cfg-chat-negative-prompt'),
            createCfgTextareaRow(root, 'chat_cfg_positive_prompt', 'Positive Prompt', 'cfg-chat-positive-prompt'),
            chatUseCharacter,
        ],
    });

    const characterParts = getSectionParts(characterContainer, 'CFG character');
    createCfgSection({
        container: characterContainer,
        title: t`Character CFG`,
        titleKey: 'Character CFG',
        field: 'cfg-character',
        description: characterParts.content.querySelector('small'),
        rows: [
            createCfgSliderRow(root, 'chara_cfg_guidance_scale', 'cfg-character-scale'),
            createCfgTextareaRow(root, 'chara_cfg_negative_prompt', 'Negative Prompt', 'cfg-character-negative-prompt'),
            createCfgTextareaRow(root, 'chara_cfg_positive_prompt', 'Positive Prompt', 'cfg-character-positive-prompt'),
        ],
    });

    const globalParts = getSectionParts(globalContainer, 'CFG global');
    createCfgSection({
        container: globalContainer,
        title: t`Global CFG`,
        titleKey: 'Global CFG',
        field: 'cfg-global',
        description: globalParts.content.querySelector('small'),
        rows: [
            createCfgSliderRow(root, 'global_cfg_guidance_scale', 'cfg-global-scale'),
            createCfgTextareaRow(root, 'global_cfg_negative_prompt', 'Negative Prompt', 'cfg-global-negative-prompt'),
            createCfgTextareaRow(root, 'global_cfg_positive_prompt', 'Positive Prompt', 'cfg-global-positive-prompt'),
        ],
    });

    const cascadingParts = getSectionParts(cascadingContainer, 'CFG prompt cascading');
    const checkRows = [...root.querySelectorAll('input[type="checkbox"][name="cfg_prompt_combine"]')].map(input => {
        const label = input.closest('label');
        const text = label?.querySelector('span[data-i18n]')?.dataset.i18n;
        if (!text) throw new TypeError('A CFG prompt-combine switch needs its translated label.');
        const checkRow = createCheckRow({ label: t`${text}`, field: `cfg-prompt-combine-${input.value}`, input });
        setRowLabel(checkRow.row, text);
        return checkRow.row;
    });
    if (checkRows.length !== 3) throw new TypeError('The CFG side panel needs three prompt-combine switches.');
    const alwaysIncludeLabel = document.createElement('div');
    alwaysIncludeLabel.className = 'ds-row sb-side-panel__subheading';
    const alwaysIncludeText = document.createElement('span');
    alwaysIncludeText.className = 'ds-row-label';
    alwaysIncludeText.dataset.i18n = 'Always Include';
    alwaysIncludeText.textContent = t`Always Include`;
    alwaysIncludeLabel.append(alwaysIncludeText);
    const separatorInput = requireInput(root, '#cfg_prompt_separator', 'text', 'CFG');
    const depthInput = requireInput(root, '#cfg_prompt_insertion_depth', 'number', 'CFG');
    const separatorRow = createEntryRow({ label: t`Custom Separator:`, field: 'cfg-prompt-separator', input: separatorInput });
    setRowLabel(separatorRow.row, 'Custom Separator:');
    const depthRow = createSpinRow({ label: t`Insertion Depth:`, field: 'cfg-prompt-insertion-depth', input: depthInput, normalize: false });
    setRowLabel(depthRow.row, 'Insertion Depth:');
    const cascadingDescription = cascadingParts.content.querySelector('small');
    createCfgSection({
        container: cascadingContainer,
        title: t`CFG Prompt Cascading`,
        titleKey: 'CFG Prompt Cascading',
        field: 'cfg-prompt-cascading',
        description: cascadingDescription,
        rows: [alwaysIncludeLabel, ...checkRows, separatorRow.row, depthRow.row],
    });

    for (const holder of root.querySelectorAll('[name="cfgConfigHolder"]')) holder.classList.remove('scrollY');
    root.classList.remove('inline-drawer', 'flexGap5');
    root.dataset.sbSidePanelAdapter = 'cfg';
}

export function registerCfgPanel(element = document.getElementById('cfgConfig')) {
    if (!(element instanceof HTMLElement)) throw new TypeError('The CFG side panel element is required.');
    if (controllers.has('cfgConfig')) return controllers.get('cfgConfig');
    adaptCfg(element);
    const controller = registerSidePanel({ id: 'cfgConfig', element, title: t`CFG`, defaultSide: 'left' });
    controllers.set('cfgConfig', controller);
    return controller;
}

export function toggleCfgPanel(opener = document.activeElement) {
    const controller = controllers.get('cfgConfig');
    if (!controller) throw new Error('CFG side panel has not been registered.');
    return controller.isOpen ? controller.close() : controller.open({ opener });
}

export function closeCfgPanel(options) {
    return controllers.get('cfgConfig')?.close(options) ?? false;
}

export function registerTokenProbabilitiesPanel(element = document.getElementById('logprobsViewer')) {
    if (!(element instanceof HTMLElement)) throw new TypeError('The Token Probabilities side panel element is required.');
    if (controllers.has('logprobsViewer')) return controllers.get('logprobsViewer');
    const content = requireElement(element, '.logprobs_panel_content', 'Token Probabilities');
    content.classList.remove('inline-drawer-content');
    content.style.removeProperty('display');
    const group = createPrefGroup({ field: 'token-probabilities', rows: [content] });
    element.append(group.section);
    element.classList.remove('inline-drawer', 'flexGap5');
    element.dataset.sbSidePanelAdapter = 'token-probabilities';
    const controller = registerSidePanel({ id: 'logprobsViewer', element, title: t`Token Probabilities`, defaultSide: 'right' });
    controllers.set('logprobsViewer', controller);
    return controller;
}

export function toggleTokenProbabilitiesPanel(opener = document.activeElement) {
    const controller = controllers.get('logprobsViewer');
    if (!controller) throw new Error('Token Probabilities side panel has not been registered.');
    return controller.isOpen ? controller.close() : controller.open({ opener });
}

export function closeTokenProbabilitiesPanel(options) {
    return controllers.get('logprobsViewer')?.close(options) ?? false;
}
