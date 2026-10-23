import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { t } from '../../../i18n.js';
import { createEntryRow, createSpinRow, createSwitchRow, createRow, releaseRowIds } from '../../../sillybunny-editor/rows.js';
import { validateAgentRegexScript } from './agent-editor-model.js';
import { createToggleRow } from '../../../sillybunny-editor/toggle-row.js';

const element = (tag, text = '') => Object.assign(document.createElement(tag), { textContent: text });

/** One helper transaction owns every sequential popup and ignores late AI results after teardown. */
export function createAgentEditorDialogs({
    services,
    isCurrent,
}) {
    let busy = false;
    let disposed = false;
    let activePopup = null;
    const current = () => !disposed && isCurrent();
    async function run(action) {
        if (busy || !current() || document.querySelector('dialog[open]')) return null;
        busy = true;
        const focus = document.activeElement;
        try {
            const result = await action(current);
            return current() ? result : null;
        } finally {
            busy = false;
            if (current() && focus?.isConnected) focus.focus({ preventScroll: true });
        }
    }
    async function showPopup(popup) {
        if (!current()) return POPUP_RESULT.CANCELLED;
        popup.dlg.classList.add('ica-agent-editor-dialog');
        activePopup = popup;
        try {
            return await popup.show();
        } finally {
            if (activePopup === popup) activePopup = null;
        }
    }
    async function show(content, options = {}) {
        if (!current()) return false;
        const result = await showPopup(new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Apply`,
            cancelButton: t`Discard`,
            wide: true,
            ...options,
        }));
        return current() && result === POPUP_RESULT.AFFIRMATIVE;
    }
    return {
        preview: agent => run(() => services.preview(agent)),
        feedback: agent => run(() => services.feedback(agent)),
        refine: agent => run(() => services.refine(agent.prompt, agent.category, agent.phase, agent.connectionProfile, current)),
        regex: script => run(async () => {
            const draft = services.normalizeRegex(structuredClone(script ?? services.createRegex()));
            const form = element('div');
            form.className = 'ica-agent-regex-dialog';
            const views = [];
            const entry = (key, label) => {
                const view = createEntryRow({
                    field: key,
                    label,
                    value: draft[key],
                    onInput: value => {
                        draft[key] = value;
                    },
                });
                views.push(view);
                form.append(view.row);
                return view;
            };
            entry('scriptName', t`Script Name`);
            const find = entry('findRegex', t`Find`);
            const error = element('div', t`Regex scripts need a find pattern`);
            error.className = 'ica-agent-field-error';
            error.id = `${find.control.id}-error`;
            error.hidden = true;
            find.control.setAttribute('aria-describedby', error.id);
            form.append(error);
            for (const [key, label] of [['replaceString', t`Replace`], ['trimStrings', t`Trim`]]) {
                const input = element('textarea');
                input.className = 'text_pole';
                input.rows = 5;
                input.value = Array.isArray(draft[key]) ? draft[key].join('\n') : draft[key];
                input.setAttribute('aria-label', label);
                input.addEventListener(
                    'input',
                    () => {
                        draft[key] = key === 'trimStrings' ? input.value.split('\n').filter(Boolean) : input.value;
                    },
                );
                const view = createRow({
                    field: key,
                    label,
                    suffix: input,
                    stacked: true,
                });
                views.push(view);
                form.append(view.row);
            }
            for (const [value, label] of services.regexPlacements) {
                const view = createSwitchRow({
                    field: `placement-${value}`,
                    label,
                    checked: draft.placement.includes(value),
                    onChange: enabled => {
                        draft.placement = enabled ? [...draft.placement, value] : draft.placement.filter(item => item !== value);
                    },
                });
                views.push(view);
                form.append(view.row);
            }
            const substitute = createToggleRow({
                field: 'substituteRegex',
                label: t`Substitute`,
                choices: services.regexSubstitutions,
                value: draft.substituteRegex,
                onChange: value => {
                    draft.substituteRegex = value;
                },
            });
            views.push(substitute);
            form.append(substitute.row);
            for (const [key, label] of [['minDepth', t`Min Depth`], ['maxDepth', t`Max Depth`]]) {
                const view = createSpinRow({
                    field: key,
                    label,
                    value: draft[key],
                    nullable: true,
                    onChange: value => {
                        draft[key] = value;
                    },
                });
                views.push(view);
                form.append(view.row);
            }
            for (const [key, label] of [
                ['markdownOnly', t`Markdown Only`],
                ['promptOnly', t`Prompt Only`],
                ['runOnEdit', t`Run on Edit`],
                ['disabled', t`Disabled`],
            ]) {
                const view = createSwitchRow({
                    field: key,
                    label,
                    checked: draft[key],
                    onChange: value => {
                        draft[key] = value;
                    },
                });
                views.push(view);
                form.append(view.row);
            }
            try {
                const accepted = await show(
                    form,
                    {
                        onClosing: popup => {
                            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return true;
                            const invalid = validateAgentRegexScript(draft).length > 0;
                            error.hidden = !invalid;
                            find.control.setAttribute('aria-invalid', String(invalid));
                            if (invalid) find.control.focus();
                            return !invalid;
                        },
                    },
                );
                return accepted ? services.normalizeRegex(draft) : null;
            } finally {
                views.forEach(view => view.destroy());
                releaseRowIds(form);
            }
        }),
        maker: agent => run(async () => {
            const form = element('div');
            const note = element('p', t`Describe the side note this companion should produce`);
            const goal = element('textarea');
            goal.id = 'ica--companion-maker-goal';
            goal.className = 'text_pole';
            goal.rows = 8;
            goal.setAttribute('aria-label', t`AI Maker`);
            form.append(note, goal);
            if (!await show(form, {
                okButton: t`Generate Companion`,
                cancelButton: t`Cancel`,
            })) return null;
            if (!goal.value.trim() && !agent.prompt.trim() && !agent.description.trim()) {
                globalThis.toastr?.warning(t`Describe what this companion should watch for`);
                return null;
            }
            const kit = await services.generateCompanionKitWithAI({
                agentName: agent.name,
                description: agent.description,
                currentPrompt: agent.prompt,
                goalText: goal.value.trim(),
                connectionProfile: agent.connectionProfile,
            });
            if (!current()) return null;
            const preview = element('div');
            preview.append(element('h3', kit.name), element('p', kit.description), element('pre', kit.prompt));
            if (!await show(preview)) return null;
            return {
                ...agent,
                name: agent.name || kit.name,
                description: agent.description || kit.description,
                category: agent.category === 'custom' ? 'companion' : agent.category,
                execution: 'companion',
                phase: 'post',
                prompt: kit.prompt,
                companion: {
                    ...agent.companion,
                    ...kit.companion,
                    includeInChatHistory: agent.companion.includeInChatHistory,
                    chatHistoryDepth: agent.companion.chatHistoryDepth,
                    includeAllChatHistory: agent.companion.includeAllChatHistory,
                    keepInChatHistoryWhenHostHidden: agent.companion.keepInChatHistoryWhenHostHidden,
                },
            };
        }),
        tracker: (agent, notes) => run(async () => {
            if (!services.parseTrackerFormat(notes.format)) {
                globalThis.toastr?.warning(t`Paste a tracker example with at least one opening tag like [TRACKER|Field]`);
                return null;
            }
            const args = {
                agentName: agent.name,
                description: agent.description,
                currentPrompt: agent.prompt,
                formatText: notes.format,
                rulesText: notes.rules,
                styleNotes: notes.style,
                connectionProfile: agent.connectionProfile,
            };
            let kit = await services.generateTrackerKitWithAI(args);
            if (!current()) return null;
            const popup = new Popup(
                services.buildTrackerPreviewPopupContent(kit, notes.format),
                POPUP_TYPE.CONFIRM,
                '',
                {
                    okButton: t`Apply`,
                    cancelButton: t`Discard`,
                    wide: true,
                    large: true,
                    customButtons: [
                        {
                            text: t`Regenerate`,
                            action: async event => {
                                const button = event.currentTarget;
                                if (button.disabled || !current()) return;
                                button.disabled = true;
                                try {
                                    const extraInstructions = popup.content
                                        .querySelector('#ica--tracker-builder-extra-instructions')?.value.trim() || '';
                                    const regenerated = await services.generateTrackerKitWithAI({
                                        ...args,
                                        currentPrompt: kit.prompt || agent.prompt,
                                        extraInstructions,
                                    });
                                    if (!current() || !popup.dlg?.open) return;
                                    kit = regenerated;
                                    $(popup.content).empty().append(services.buildTrackerPreviewPopupContent(
                                        kit,
                                        notes.format,
                                        extraInstructions,
                                    ));
                                } catch (error) {
                                    if (current() && popup.dlg?.open) globalThis.toastr?.error(error.message);
                                } finally {
                                    button.disabled = false;
                                }
                            },
                        },
                    ],
                },
            );
            if (await showPopup(popup) !== POPUP_RESULT.AFFIRMATIVE || !current()) return null;
            return {
                ...agent,
                name: agent.name || kit.name,
                description: agent.description || kit.description,
                category: 'tracker',
                phase: kit.phase,
                prompt: kit.prompt,
                postProcess: {
                    ...agent.postProcess,
                    promptTransformEnabled: false,
                    enabled: true,
                    type: 'extract',
                    extractPattern: kit.postProcess.extractPattern,
                    extractVariable: kit.postProcess.extractVariable,
                    appendText: '',
                },
                regexScripts: kit.regexScripts,
            };
        }),
        destroy() {
            disposed = true;
            void activePopup?.completeCancelled();
        },
    };
}
