import { t, translate } from '../../../i18n.js';
import { getCurrentUserHandle } from '../../../user.js';
import {
    createRow,
    createEntryRow,
    createSpinRow,
    createSwitchRow,
    createPropertyRow,
    createButtonRow,
    createPrefGroup,
    releaseRowIds,
} from '../../../sillybunny-editor/rows.js';
import { createToggleRow } from '../../../sillybunny-editor/toggle-row.js';
import { createSelectRow, createProfileRow } from '../../../sillybunny-editor/select-row.js';
import { createChipEntry } from '../../../sillybunny-editor/chip-entry.js';
import { mountEditorChrome, showDraftRecoveryToast } from '../../../sillybunny-editor/chrome.js';
import { confirmEditorLeave } from '../../../sillybunny-editor/navigation.js';
import { confirmDestructiveAction } from '../../../sillybunny-delete-confirm.js';
import { openActionMenu } from '../../../sillybunny-action-menu.js';
import { createAgentEditorController } from './agent-editor-controller.js';
import { createAgentEditorState, getAgentEditorVisibility } from './agent-editor-model.js';
import { createAgentEditorDialogs } from './agent-editor-dialogs.js';
import { createSegmentedControl, setSegmentedControlValue } from '../../../sillybunny-segmented-control.js';
import { createAgentEditorProperties } from './agent-editor-properties.js';
import { companionLabels } from './companion-labels.js';

let nextId = 0;
const element = (tag, className = '', text = '') => Object.assign(document.createElement(tag), {
    className,
    textContent: text,
});
const read = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
function button(label, icon, classes = '') {
    const node = element('button', `menu_button menu_button_icon ${classes}`);
    node.type = 'button';
    node.title = label;
    node.setAttribute('aria-label', label);
    const glyph = element('i', `fa-solid fa-${icon}`);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph);
    return node;
}

// SillyBunny: the generic agent modal now has a shared explicit-save detail-page counterpart.
export function mountAgentDetail({
    host,
    entry,
    draft,
    adapter,
    preparePopup = () => {},
    requestClose,
    onSaved = () => {},
    onStateChange = () => {},
}) {
    let destroyed = false;
    let controller;
    let chrome;
    let recovery;
    let showingPreview = false;
    const views = new Map();
    const sections = new Map();
    const chips = [];
    const id = `ica-agent-detail-${++nextId}`;
    const initial = createAgentEditorState(draft ?? entry.agent).fields;
    initial.settings = adapter.editor.templateSettings(initial);
    const root = element('section', 'sb-persona-entry ica-agent-detail');
    root.tabIndex = -1;
    const header = element('header', 'sb-persona-detail-header sb-persona-entry-header');
    const back = button(t`Back`, 'chevron-left', 'sb-persona-detail-back');
    const title = element('input', 'sb-persona-entry-name');
    title.type = 'text';
    title.autocomplete = 'off';
    title.dataset.sbEditorField = 'name';
    title.setAttribute('aria-label', t`Name`);
    title.value = initial.name;
    title.addEventListener('input', () => update('name', title.value));
    const dirty = element('span', 'sb-persona-entry-dirty', '•');
    dirty.hidden = true;
    dirty.setAttribute('aria-label', t`Unsaved changes`);
    const modes = createSegmentedControl(
        t`Edit / Preview`,
        [[false, t`Edit`], [true, t`Preview`]],
        false,
        setPreview,
        { compact: true, detachFromForm: true },
    );
    modes.classList.add('sb-persona-entry-modes');
    const modeToggle = button(t`Preview`, 'eye', 'sb-persona-entry-mode-toggle');
    modeToggle.addEventListener('click', () => setPreview(!showingPreview));
    const jump = button(t`Sections`, 'list');
    const more = button(t`More…`, 'ellipsis-vertical', 'sb-persona-entry-more');
    more.addEventListener('click', () => preparePopup(more), { capture: true });
    const actions = element('div', 'sb-persona-entry-actions');
    actions.append(jump, more);
    const cancel = element('button', 'sb-editor-action sb-editor-action--secondary sb-persona-entry-cancel');
    cancel.type = 'button';
    cancel.title = t`Cancel`;
    cancel.setAttribute('aria-label', t`Cancel`);
    const cancelIcon = element('i', 'fa-solid fa-xmark sb-editor-action__icon');
    cancelIcon.setAttribute('aria-hidden', 'true');
    cancel.append(cancelIcon, element('span', 'sb-editor-action__label', t`Cancel`));
    const save = element('button', 'sb-editor-action sb-editor-action--primary sb-persona-entry-save', t`Save`);
    save.type = 'button';
    header.append(back, title, dirty, modes, modeToggle, actions, cancel, save);
    const properties = createAgentEditorProperties({
        categories: Object.entries(adapter.categories)
            .filter(([key]) => key !== 'tool' || initial.category === 'tool')
            .map(([key, value]) => [key, translate(value.label)]),
        onChange: (path, value) => update(path, value),
        preparePopup,
    });
    const body = element('div', 'sb-persona-entry-body');
    const saveError = element('div', 'ica-agent-field-error', t`lorum ipsum`);
    saveError.dataset.sbCopyPlaceholder = 'true';
    saveError.hidden = true;
    saveError.setAttribute('role', 'alert');
    body.append(saveError);
    root.append(header, properties.element, body);
    host.replaceChildren(root);
    const helpers = createAgentEditorDialogs({
        services: adapter.editor,
        isCurrent: () => !destroyed && controller.isOpen(),
    });
    const update = (path, value) => controller.update(path, value);
    const register = (path, view, group, visibilityKey = path) => {
        view.row.dataset.sbEditorField = path;
        views.set(path, {
            ...view,
            visibilityKey,
        });
        group.group.append(view.row);
        return view;
    };
    const group = (key, heading, glyph) => {
        const result = createPrefGroup({
            title: heading,
            field: `section-${key}`,
            rows: [],
        });
        result.section.dataset.sbSection = key;
        sections.set(key, { ...result, icon: `fa-solid fa-${glyph}` });
        body.append(result.section);
        return result;
    };
    const text = (g, path, label) => register(path, createEntryRow({
        label,
        field: path,
        value: read(initial, path) ?? '',
        onInput: value => update(path, value),
    }), g);
    const spin = (g, path, label, options = {}) => register(
        path,
        createSpinRow({
            label,
            field: path,
            value: read(initial, path),
            onChange: value => update(path, value),
            ...options,
        }),
        g,
    );
    const toggle = (g, path, label, visibilityKey) => register(
        path,
        createSwitchRow({
            label,
            field: path,
            checked: read(initial, path),
            onChange: value => update(path, value),
        }),
        g,
        visibilityKey ?? path,
    );
    const choice = (g, path, label, choices, visibilityKey) => register(
        path,
        createToggleRow({
            label,
            field: path,
            choices,
            value: read(initial, path),
            fill: true,
            onChange: value => update(path, value),
        }),
        g,
        visibilityKey ?? path,
    );
    const select = (g, path, label, options, multiple = false) => {
        const control = element('select');
        control.multiple = multiple;
        const value = read(initial, path);
        const offered = new Set(options.map(([key]) => String(key)));
        const missing = (multiple ? value ?? [] : value == null ? [] : [value]).filter(key => !offered.has(String(key)));
        for (const [key, caption] of [...options, ...missing.map(key => [key, key])]) {
            const option = element('option', '', caption);
            option.value = key;
            option.selected = multiple ? (value ?? []).includes(key) : String(value) === String(key);
            control.append(option);
        }
        control.addEventListener(
            'change',
            () => update(path, multiple ? [...control.selectedOptions].map(option => option.value) : control.value),
        );
        const view = createSelectRow({
            select: control,
            field: path,
            label,
            bounds: root,
        });
        return register(path, {
            ...view,
            setValue: value => view.setValue(value ?? (multiple ? [] : options[0]?.[0] ?? '')),
        }, g);
    };
    const area = (g, path, label, prompt = false) => {
        const input = element(
            'textarea',
            `text_pole ${prompt ? 'sb-persona-entry-textarea ica-agent-prompt' : 'sb-persona-note-textarea'}`,
        );
        input.id = `${id}-${path.replaceAll('.', '-')}`;
        input.value = read(initial, path) ?? '';
        input.dataset.sbEditorField = path;
        input.setAttribute('aria-label', label);
        $(input).on('input.icaAgentDetail', () => update(path, input.value));
        const view = createRow({
            field: path,
            label,
            stacked: true,
            suffix: input,
        });
        const error = prompt ? element('div', 'ica-agent-field-error') : null;
        if (error) {
            error.id = `${input.id}-error`;
            error.hidden = true;
            error.setAttribute('role', 'alert');
            input.setAttribute('aria-describedby', error.id);
            view.row.append(error);
        }
        return register(
            path,
            {
                ...view,
                control: input,
                error,
                setValue: value => {
                    if (input.value !== (value ?? '')) input.value = value ?? '';
                },
            },
            g,
        );
    };
    const action = (g, label, icon, onActivate) => {
        const view = createButtonRow({
            label,
            icon,
            field: `${g.section.dataset.sbSection}-${g.group.childElementCount}`,
            onActivate: () => {
                void run(onActivate);
            },
        });
        g.group.append(view.row);
    };
    const headerAction = (g, label, icon, onActivate) => {
        const control = button(label, icon);
        control.addEventListener('click', () => {
            void run(onActivate);
        });
        headerActions(g).append(control);
    };
    function headerActions(g) {
        const header = g.section.querySelector('.ds-pref-group-header');
        let actions = header.querySelector('.ica-agent-group-actions');
        if (!actions) {
            actions = element('div', 'ica-agent-group-actions');
            header.append(actions);
        }
        return actions;
    }
    const run = async operation => {
        try {
            return await operation();
        } catch (error) {
            if (!destroyed) globalThis.toastr?.error(error.message);
        }
    };
    const fields = () => controller.getState().fields;
    const saveChanges = async () => {
        keywords.commitPending();
        const saved = await controller.save();
        if (!saved && !destroyed && controller.getState().errors.some(error => error.field === 'prompt')) {
            setPreview(false);
            promptView.control.focus();
        }
        return saved;
    };
    const apply = agent => {
        if (agent && !destroyed) for (const [key, value] of Object.entries(agent)) update(key, value);
    };
    const general = group('general', t`General`, 'gear');
    text(general, 'description', t`Description`);
    if (entry?.template) {
        const template = entry.template;
        general.group.append(createPropertyRow({
            label: t`Template`,
            field: 'template',
            value: [template.name, `v${template.version}`, template.author].filter(Boolean).join(' · '),
        }).row);
    }
    const prompt = group('prompt', t`Prompt`, 'align-left');
    const profileSelect = element('select');
    adapter.editor.populateProfiles(profileSelect, initial.connectionProfile);
    profileSelect.addEventListener('change', () => update('connectionProfile', profileSelect.value));
    register(
        'connectionProfile',
        createProfileRow({
            label: t`Connection Profile`,
            field: 'connectionProfile',
            select: profileSelect,
            bounds: root,
            menuLabel: t`Connection Profile`,
            onMenu: trigger => adapter.editor.profileMenu(trigger, profileSelect),
        }),
        prompt,
    );
    text(prompt, 'modelOverride', t`Model Override`);
    const promptView = area(prompt, 'prompt', t`Prompt`, true);
    // Full-context generation preview stays distinct from the header's local text preview.
    const previewPrompt = button(t`Preview Prompt in Context`, 'file-lines');
    previewPrompt.addEventListener('click', () => {
        void run(() => helpers.preview(fields()));
    });
    const refine = button(t`Refine…`, 'wand-magic-sparkles');
    refine.addEventListener('click', () => {
        void run(async () => {
            const value = await helpers.refine(fields());
            if (value != null && !destroyed) update('prompt', value);
        });
    });
    actions.replaceChildren(jump, previewPrompt, refine, more);
    const headerTasks = [jump, previewPrompt, refine];
    let headerFrame = 0;
    const scheduleHeaderActions = () => {
        if (headerFrame) return;
        headerFrame = requestAnimationFrame(() => {
            headerFrame = 0;
            if (destroyed) return;
            const fixed = [...header.children].filter(node => node !== title && node !== actions && node.getClientRects().length);
            const style = getComputedStyle(header);
            const available = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
                - fixed.reduce((sum, node) => sum + node.getBoundingClientRect().width, 0)
                - parseFloat(getComputedStyle(title).minWidth) - more.getBoundingClientRect().width
                - (fixed.length + 2) * (parseFloat(style.gap) || 0);
            let count = matchMedia('(max-width: 768px)').matches ? 0 : headerTasks.length;
            while (count > 0 && count * 42 > available) count--;
            for (const [index, control] of headerTasks.entries()) {
                if (index >= count && document.activeElement === control) title.focus({ preventScroll: true });
                control.hidden = index >= count;
            }
        });
    };
    const headerResize = new ResizeObserver(scheduleHeaderActions);
    headerResize.observe(header);
    promptView.row.classList.add('ica-agent-prompt-content');
    promptView.row.querySelector('.ds-row-text').remove();
    prompt.section.append(promptView.row);
    const preview = element('pre', 'sb-preview-pane sb-persona-entry-preview ica-agent-prompt-preview');
    preview.setAttribute('aria-label', t`Prompt`);
    preview.tabIndex = 0;
    preview.hidden = true;
    promptView.control.parentElement.append(preview);
    const promptFooter = element('footer', 'sb-persona-entry-footer ica-agent-prompt-footer');
    const expand = button(t`Expand the editor`, 'maximize', 'editor_maximize sb-persona-entry-expand');
    expand.dataset.for = promptView.control.id;
    promptFooter.append(expand);
    prompt.section.append(promptFooter);
    let textareaViewportFrame = 0;
    const keepFocusedTextareaVisible = () => {
        cancelAnimationFrame(textareaViewportFrame);
        textareaViewportFrame = requestAnimationFrame(() => {
            textareaViewportFrame = 0;
            const focused = document.activeElement;
            if (destroyed || !focused?.matches('textarea') || !body.contains(focused) || !matchMedia('(max-width: 768px)').matches) return;
            const rect = focused.getBoundingClientRect();
            const bounds = body.getBoundingClientRect();
            const viewport = globalThis.visualViewport;
            const bottom = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight)) - 8;
            const top = bounds.top + 8;
            if (rect.top < top || rect.height > bottom - top) body.scrollTop += rect.top - top;
            else if (rect.bottom > bottom) body.scrollTop += rect.bottom - bottom;
        });
    };
    const textareaViewportResize = new ResizeObserver(keepFocusedTextareaVisible);
    textareaViewportResize.observe(body);
    body.addEventListener('focusin', keepFocusedTextareaVisible);
    globalThis.visualViewport?.addEventListener('resize', keepFocusedTextareaVisible);
    function setPreview(show) {
        showingPreview = show;
        setSegmentedControlValue(modes, show);
        const label = show ? t`Edit` : t`Preview`;
        modeToggle.title = label;
        modeToggle.setAttribute('aria-label', label);
        modeToggle.setAttribute('aria-pressed', String(show));
        modeToggle.querySelector('i').className = `fa-solid fa-${show ? 'pen' : 'eye'}`;
        if (show) {
            preview.style.height = `${promptView.control.getBoundingClientRect().height}px`;
            preview.textContent = fields().prompt;
        }
        promptView.control.hidden = show;
        preview.hidden = !show;
        expand.hidden = show;
    }
    const output = group('companion-output', t`Companion · Output`, 'paper-plane');
    const companionCopy = companionLabels();
    choice(output, 'companion.trigger', t`Trigger`, companionCopy.trigger);
    choice(
        output,
        'companion.displayMode',
        t`Display`,
        companionCopy.displayMode,
    );
    choice(output, 'companion.format', t`Format`, companionCopy.format);
    spin(output, 'companion.maxTokens', t`Max Tokens`);
    const order = spin(output, 'injection.order', t`Order`);
    headerAction(output, t`AI Maker…`, 'wand-magic-sparkles', async () => apply(await helpers.maker(fields())));
    const context = group('companion-context', t`Companion · Context`, 'file-lines');
    spin(context, 'companion.contextMessages', t`Context Messages`);
    spin(context, 'companion.minContextTokens', t`Min Context Tokens`);
    for (const [key, label] of [
        ['includeCharacterCard', t`Include Character Card`],
        ['includePersona', t`Include Persona`],
        ['includeWorldInfo', t`Include World Info`],
        ['includeAuthorsNote', t`Include Author’s Note`],
        ['includeSystemPrompt', t`Include System Prompt`],
        ['includeHistory', t`Include Prior Notes`],
        ['rawPrompt', t`Use Prompt As-Is`],
    ]) toggle(context, `companion.${key}`, label);
    spin(context, 'companion.historyDepth', t`History Depth`);
    const history = group('companion-chat-history', t`Companion · Chat History`, 'clock-rotate-left');
    toggle(history, 'companion.includeInChatHistory', t`Keep in Chat History`);
    spin(history, 'companion.chatHistoryDepth', t`Notes to Keep`);
    toggle(history, 'companion.includeAllChatHistory', t`Keep All`);
    toggle(history, 'companion.keepInChatHistoryWhenHostHidden', t`Keep When Hidden`);
    const feedback = group('companion-feedback', t`Companion · Feedback`, 'comment-dots');
    toggle(feedback, 'companion.feedback.enabled', companionCopy.feedback);
    spin(feedback, 'companion.feedback.depth', t`Feedback Depth`);
    action(feedback, t`Preview Feedback`, 'file-lines', () => helpers.feedback(fields()));
    const coordination = group('companion-coordination', t`Companion · Coordination`, 'diagram-project');
    const companions = path => adapter.editor.companions(initial.id, path === 'companion.batchAgentIds', read(initial, path));
    toggle(coordination, 'companion.batch', companionCopy.batch);
    select(coordination, 'companion.batchAgentIds', t`Companions`, companions('companion.batchAgentIds'), true);
    toggle(coordination, 'companion.sendContextToCompanions', t`Send Context`);
    select(coordination, 'companion.contextRecipientAgentIds', t`Recipients`, companions('companion.contextRecipientAgentIds'), true);
    select(coordination, 'companion.dependencies', t`Re-run After`, companions('companion.dependencies'), true);
    toggle(coordination, 'companion.waitForDependencies', t`Wait`);
    const options = group('template-options', t`Template Options`, 'sliders');
    select(options, 'settings.chatroomStyle', t`Chatroom Style`, adapter.editor.chatroomStyles);
    const customStyle = select(
        options,
        'settings.chatroomCustomStyleName',
        t`Custom Style`,
        adapter.editor.customStyles(initial.settings.chatroomCustomStyles),
    );
    area(options, 'settings.chatroomCustomStyles', t`Custom Styles`);
    select(options, 'settings.chatroomExtraCharacterAvatars', t`Extra Character Cards`, adapter.editor.characters(), true);
    select(options, 'settings.directorCommentaryVoice', t`Commentary Voice`, adapter.editor.directorVoices);
    const customVoice = select(
        options,
        'settings.directorCommentaryCustomVoiceName',
        t`Custom Voice`,
        adapter.editor.customVoices(initial.settings.directorCommentaryCustomVoices),
    );
    area(options, 'settings.directorCommentaryCustomVoices', t`Custom Voices`);
    area(options, 'settings.plotCompassObjective', t`Objective`);
    const tracker = group('tracker-builder', t`Tracker Builder`, 'chart-line');
    for (const [key, label] of [
        ['format', t`Format Example`],
        ['rules', t`Rules / Behaviour Notes`],
        ['style', t`HTML / Style Notes`],
    ]) area(tracker, `trackerBuilder.${key}`, label);
    action(
        tracker,
        t`Generate Kit…`,
        'wand-magic-sparkles',
        async () => apply(await helpers.tracker(fields(), controller.getState().trackerBuilder)),
    );
    const before = group('before', t`Before Reply`, 'right-to-bracket');
    choice(before, 'preProcess.mode', t`Mode`, [['inject', t`Inject`], ['intercept', t`Intercept`]], 'preProcess');
    choice(
        before,
        'preProcess.interceptTiming',
        t`Timing`,
        [['pre-generation', t`Before generation`], ['post-main-generation', t`After main generation`]],
    );
    choice(before, 'preProcess.applyMode', t`Apply Mode`, [['replace', t`Replace`], ['wrap', t`Wrap`], ['patch', t`Patch`]]);
    spin(before, 'preProcess.maxTokens', t`Max Tokens`);
    choice(before, 'preProcess.wrapPosition', t`Insert Position`, [['before', t`Before`], ['after', t`After`]]);
    area(before, 'preProcess.wrapPrefix', t`Prefix`);
    area(before, 'preProcess.wrapSuffix', t`Suffix`);
    text(before, 'preProcess.patchStartTag', t`Start Tag`);
    text(before, 'preProcess.patchEndTag', t`End Tag`);
    choice(before, 'injection.position', t`Position`, [[0, t`In prompt`], [1, t`In chat`], [2, t`Before prompt`]], 'injection');
    spin(before, 'injection.depth', t`Depth`);
    choice(before, 'injection.role', t`Role`, [[0, t`System`], [1, t`User`], [2, t`Assistant`]], 'injection');
    toggle(before, 'injection.scan', t`Scan World Info`, 'injection');
    const after = group('after', t`After Reply`, 'right-from-bracket');
    toggle(after, 'postProcess.promptTransformEnabled', t`Prompt Pass`);
    choice(after, 'postProcess.promptTransformMode', t`Mode`, [['rewrite', t`Rewrite`], ['append', t`Append`]]);
    spin(after, 'postProcess.promptTransformMaxTokens', t`Max Tokens`);
    toggle(after, 'postProcess.promptTransformShowNotifications', t`Notifications`);
    toggle(after, 'conditions.runOnImpersonate', t`Run on Impersonation`);
    toggle(after, 'conditions.runOnCompanionOutputs', t`Run on Companion Outputs`);
    select(
        after,
        'conditions.companionOutputTargetAgentIds',
        t`Targets`,
        companions('conditions.companionOutputTargetAgentIds'),
        true,
    );
    toggle(after, 'postProcess.enabled', t`Utility Post-processing`);
    choice(after, 'postProcess.type', t`Type`, [['extract', t`Extract`], ['append', t`Append`]]);
    text(after, 'postProcess.extractPattern', t`Extract Pattern`);
    text(after, 'postProcess.extractVariable', t`Extract Variable`);
    area(after, 'postProcess.appendText', t`Append Text`);
    const regex = group('regex', t`Regex Scripts`, 'code');
    const regexList = element('div', 'ica-agent-regex-list');
    regex.group.append(regexList);
    let regexSignature = '';
    const editRegex = async index => {
        const scripts = fields().regexScripts;
        const script = await helpers.regex(index == null ? null : scripts[index]);
        if (!script || destroyed) return;
        if (index == null) scripts.push(script); else scripts[index] = script;
        update('regexScripts', scripts);
    };
    action(regex, t`Add Regex Script`, 'plus', () => editRegex(null));
    if (entry?.template?.regexScripts?.length) action(
        regex,
        t`Load Bundled Regex`,
        'download',
        () => update('regexScripts', entry.template.regexScripts),
    );
    const conditions = group('conditions', t`Conditions`, 'filter');
    spin(conditions, 'conditions.triggerProbability', t`Probability`, {
        min: 0,
        max: 100,
    });
    const keywords = createChipEntry({
        label: t`Trigger Keywords`,
        field: 'conditions.triggerKeywords',
        values: initial.conditions?.triggerKeywords ?? [],
        split: value => [value],
        onChange: value => update('conditions.triggerKeywords', value),
    });
    chips.push(keywords);
    register(
        'conditions.triggerKeywords',
        {
            ...createRow({
                label: t`Trigger Keywords`,
                field: 'conditions.triggerKeywords',
                suffix: keywords.element,
                stacked: true,
            }),
            setValue: value => {
                if (JSON.stringify(value) !== JSON.stringify(keywords.getValues())) keywords.setValues(value);
            },
        },
        conditions,
    );
    for (const [value, label] of [
        ['normal', t`Normal`],
        ['continue', t`Continue`],
        ['impersonate', t`Impersonate`],
        ['quiet', t`Quiet`],
    ]) {
        const view = createSwitchRow({
            field: `generation-${value}`,
            label,
            onChange: enabled => {
                const types = fields().conditions.generationTypes;
                update('conditions.generationTypes', enabled ? [...types, value] : types.filter(type => type !== value));
            },
        });
        conditions.group.append(view.row);
        views.set(`generation-${value}`, {
            ...view,
            generationType: value,
        });
    }
    function renderRegex(scripts) {
        const signature = JSON.stringify(scripts);
        if (signature === regexSignature) return;
        regexSignature = signature;
        releaseRowIds(regexList);
        regexList.replaceChildren();
        scripts.forEach((script, index) => {
            const view = createSwitchRow({
                label: script.scriptName || t`Regex Script`,
                field: `regex-${script.id}`,
                checked: !script.disabled,
                onChange: enabled => {
                    const next = fields().regexScripts;
                    next[index].disabled = !enabled;
                    update('regexScripts', next);
                },
            });
            // The row's menu must not become part of the switch's accessible name.
            view.control.setAttribute('aria-label', script.scriptName || t`Regex Script`);
            const menu = button(t`Regex Script`, 'ellipsis-vertical');
            menu.addEventListener(
                'click',
                () => openActionMenu({
                    trigger: menu,
                    sections: [
                        {
                            items: [
                                {
                                    label: t`Edit…`,
                                    icon: 'fa-solid fa-pen',
                                    onSelect: () => {
                                        void run(() => editRegex(index));
                                    },
                                },
                                ...[-1, 1].filter(direction => scripts[index + direction]).map(direction => ({
                                    label: direction < 0 ? t`Move Up` : t`Move Down`,
                                    icon: direction < 0 ? 'fa-solid fa-arrow-up' : 'fa-solid fa-arrow-down',
                                    onSelect: () => {
                                        const next = fields().regexScripts;
                                        [next[index], next[index + direction]] = [next[index + direction], next[index]];
                                        update('regexScripts', next);
                                    },
                                })),
                            ],
                        },
                        {
                            items: [
                                {
                                    label: t`Delete…`,
                                    danger: true,
                                    icon: 'fa-solid fa-trash',
                                    onSelect: () => {
                                        void run(async () => {
                                            if (await confirmDestructiveAction({
                                                text: t`lorum ipsum`,
                                                confirmLabel: t`Delete`,
                                                copyPlaceholder: true,
                                            })) update('regexScripts', fields().regexScripts.filter(item => item.id !== script.id));
                                        });
                                    },
                                },
                            ],
                        },
                    ],
                }),
            );
            view.row.append(menu);
            regexList.append(view.row);
        });
    }
    function render(state) {
        if (destroyed || !chrome) return;
        for (const [view, parse, library, selected] of [
            [
                customStyle,
                adapter.editor.customStyles,
                state.fields.settings.chatroomCustomStyles,
                state.fields.settings.chatroomCustomStyleName,
            ],
            [
                customVoice,
                adapter.editor.customVoices,
                state.fields.settings.directorCommentaryCustomVoices,
                state.fields.settings.directorCommentaryCustomVoiceName,
            ],
        ]) {
            const items = parse(library);
            const signature = JSON.stringify(items);
            if (view.control.dataset.library === signature) continue;
            view.control.dataset.library = signature;
            view.control.replaceChildren(...items.map(([value, label]) => new Option(label, value)));
            view.setValue(selected);
        }
        const visibility = getAgentEditorVisibility(state.fields);
        properties.render(state.fields, visibility);
        for (const [key, section] of sections) section.section.hidden = !visibility.groups.includes(key);
        const orderGroup = state.fields.execution === 'companion' ? output : before;
        if (order.row.parentElement !== orderGroup.group) orderGroup.group.append(order.row);
        for (const [path, view] of views) {
            view.setValue?.(
                view.generationType ? state.fields.conditions.generationTypes.includes(view.generationType)
                    : path.startsWith('trackerBuilder.') ? read(state, path) : read(state.fields, path),
            );
            view.setVisible?.(visibility.fields[view.visibilityKey] !== false);
            view.setDisabled?.(Boolean(visibility.disabled[path]));
            if (view.error) {
                const issue = state.errors.find(error => error.field === path);
                view.error.textContent = issue?.code === 'companion-prompt-required' ? t`Companion execution needs an agent prompt`
                    : issue?.code === 'intercept-prompt-required' ? t`Pre-generation intercept mode needs an agent prompt`
                        : t`Prompt-based post-generation passes need an agent prompt`;
                view.error.hidden = !issue;
                view.control.setAttribute('aria-invalid', String(Boolean(issue)));
            }
        }
        renderRegex(state.fields.regexScripts);
        if (title.value !== state.fields.name) title.value = state.fields.name;
        if (showingPreview) preview.textContent = state.fields.prompt;
        saveError.hidden = !state.errors.some(error => error.field === 'save');
        chrome.render({
            ...state,
            title: state.fields.name || t`New Agent`,
            canCreate: true,
        });
        cancel.disabled ||= state.saving;
        root.setAttribute('aria-busy', String(state.saving));
        save.textContent = t`Save`;
        scheduleHeaderActions();
        onStateChange(state);
    }
    const savedAction = actionName => controller.requestLeave({
        reason: actionName,
        proceed: async () => {
            if (controller.getState().mode === 'create') return;
            const saved = adapter.getEntries().find(item => item.key === controller.getState().key);
            if (!saved) return;
            const destructive = ['delete', 'restore-default'].includes(actionName);
            if (destructive && !await confirmDestructiveAction({
                text: t`lorum ipsum`,
                confirmLabel: actionName === 'delete' ? t`Delete` : t`Restore Default`,
                copyPlaceholder: true,
            })) return;
            await adapter.perform(saved, actionName);
            if (destructive) {
                controller.discard();
                await requestClose();
            }
        },
    });
    chrome = mountEditorChrome({
        root,
        header,
        content: body,
        scrollHide: false,
        controls: {
            back,
            title,
            dirty,
            more,
            cancel,
            save,
        },
        onBack: () => {
            void requestClose();
        },
        onCancel: () => {
            document.activeElement?.blur();
            controller.discard();
            setPreview(false);
            title.focus({ preventScroll: true });
        },
        onSave: () => {
            void saveChanges();
        },
        getActionSections: () => [
            {
                items: [
                    // Create mode has no saved-entry actions; keep More useful even without overflow.
                    ...headerTasks.filter(control => control.hidden || controller.getState().mode === 'create').map(control => ({
                        label: control.getAttribute('aria-label'),
                        icon: control.querySelector('i').className,
                        onSelect: () => control.click(),
                    })),
                    ...(controller.getState().mode === 'edit' ? [
                        {
                            label: t`Duplicate`,
                            icon: 'fa-solid fa-clone',
                            onSelect: () => {
                                void run(() => savedAction('duplicate'));
                            },
                        },
                        {
                            label: t`Export…`,
                            icon: 'fa-solid fa-file-export',
                            onSelect: () => {
                                void run(() => savedAction('export'));
                            },
                        },
                    ] : []),
                ],
            },
            ...(controller.getState().mode === 'edit' ? [
                {
                    items: [
                        ...(entry?.template ? [
                            {
                                label: t`Restore Default…`,
                                danger: true,
                                icon: 'fa-solid fa-rotate-left',
                                onSelect: () => {
                                    void run(() => savedAction('restore-default'));
                                },
                            },
                        ] : []),
                        {
                            label: t`Delete…`,
                            danger: true,
                            icon: 'fa-solid fa-trash',
                            onSelect: () => {
                                void run(() => savedAction('delete'));
                            },
                        },
                    ],
                },
            ] : []),
        ],
    });
    jump.addEventListener(
        'click',
        () => {
            preparePopup(jump.hidden ? more : jump);
            openActionMenu({
                trigger: jump.hidden ? more : jump,
                title: t`Sections`,
                sections: [
                    {
                        items: [...sections.values()].filter(section => !section.section.hidden).map(section => ({
                            label: section.section.querySelector('.ds-pref-group-heading').textContent,
                            icon: section.icon,
                            onSelect: () => {
                                // scrollIntoView also scrolls the shell host, displacing the entire editor card.
                                body.scrollTop += section.section.getBoundingClientRect().top - body.getBoundingClientRect().top
                                    - parseFloat(getComputedStyle(body).paddingTop);
                                section.section.tabIndex = -1;
                                section.section.focus({ preventScroll: true });
                            },
                        })),
                    },
                ],
            });
        },
    );
    controller = createAgentEditorController({
        agent: initial,
        mode: draft ? 'create' : 'edit',
        template: entry?.template,
        materialiseTemplateId: entry?.kind === 'agent-template' ? entry.template.id : null,
        userHandle: getCurrentUserHandle(),
        offerDraft: (stored, actions) => {
            recovery = {
                stored,
                actions,
            };
        },
        onStateChange: render,
        services: {
            ...adapter.editor,
            confirmLeave: confirmEditorLeave,
            refreshList: (saved, previousKey) => {
                onSaved(saved, previousKey);
            },
        },
    });
    render(controller.getState());
    setPreview(false);
    if (recovery) showDraftRecoveryToast(recovery.stored, recovery.actions);
    return {
        ...controller,
        root,
        closePopover: properties.closePopover,
        save: saveChanges,
        focus: () => title.focus({ preventScroll: true }),
        maker: () => run(async () => apply(await helpers.maker(fields()))),
        destroy() {
            destroyed = true;
            headerResize.disconnect();
            cancelAnimationFrame(headerFrame);
            cancelAnimationFrame(textareaViewportFrame);
            textareaViewportResize.disconnect();
            body.removeEventListener('focusin', keepFocusedTextareaVisible);
            globalThis.visualViewport?.removeEventListener('resize', keepFocusedTextareaVisible);
            properties.destroy();
            helpers.destroy();
            chrome.dispose();
            chips.forEach(chip => chip.destroy());
            views.forEach(view => {
                if (view.control?.tagName === 'TEXTAREA') $(view.control).off('.icaAgentDetail');
                view.destroy?.();
            });
            controller.destroy({ keepDraft: true });
            releaseRowIds(root);
            root.remove();
        },
    };
}
