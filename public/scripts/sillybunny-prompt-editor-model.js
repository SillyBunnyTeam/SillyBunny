import { promptManager } from './openai.js';
import { reorderPromptOrder } from './prompt-manager-order.js';
import { getRenderedMarkerPrompt } from './prompt-manager-marker-preview.js';
import { RUNTIME_AGENTS_IDENTIFIER } from './in-chat-agent-inspection.js';

const RESET_NAMES = Object.freeze({ main: 'Main Prompt', nsfw: 'Nsfw Prompt', jailbreak: 'Jailbreak Prompt', enhanceDefinitions: 'Enhance Definitions' });
const EDIT_FIELDS = Object.freeze({
    name: 'name', role: 'role', content: 'prompt', injection_position: 'injection_position',
    injection_depth: 'injection_depth', injection_order: 'injection_order',
});

export const PROMPT_EDITOR_UTILITY_FIELDS = Object.freeze([
    ['impersonation_prompt_textarea', 'Impersonation prompt'], ['wi_format_textarea', 'World Info format'],
    ['scenario_format_textarea', 'Scenario format'], ['personality_format_textarea', 'Personality format'],
    ['group_nudge_prompt_textarea', 'Group nudge'], ['newchat_prompt_textarea', 'New chat'],
    ['newgroupchat_prompt_textarea', 'New group chat'], ['newexamplechat_prompt_textarea', 'New example chat'],
    ['continue_nudge_prompt_textarea', 'Continue nudge'], ['send_if_empty_textarea', 'Replace empty message'],
]);

const textCompletionField = (id, name) => Object.freeze({ id, name });
const textCompletionEntry = (id, name, section, fields, options = {}) => Object.freeze({
    id,
    name,
    section,
    fields: Object.freeze(fields),
    enabledBy: options.enabledBy ?? null,
    properties: Object.freeze(options.properties ?? []),
});

export const PROMPT_EDITOR_TEXT_COMPLETION_ENTRIES = Object.freeze([
    textCompletionEntry('sysprompt_content', 'System prompt', 'System prompt', [textCompletionField('sysprompt_content', 'System prompt')], { enabledBy: 'sysprompt_enabled' }),
    textCompletionEntry('sysprompt_post_history', 'Post-history instructions', 'System prompt', [textCompletionField('sysprompt_post_history', 'Post-history instructions')], { enabledBy: 'sysprompt_enabled' }),
    textCompletionEntry('context_story_string', 'Story string', 'Context', [textCompletionField('context_story_string', 'Story string')], {
        properties: [
            textCompletionField('context_story_string_position', 'Position'),
            textCompletionField('context_story_string_depth', 'Depth'),
            textCompletionField('context_story_string_role', 'Role'),
        ],
    }),
    textCompletionEntry('context_example_separator', 'Example separator', 'Context', [textCompletionField('context_example_separator', 'Example separator')]),
    textCompletionEntry('context_chat_start', 'Chat start', 'Context', [textCompletionField('context_chat_start', 'Chat start')]),
    textCompletionEntry('tc-user', 'User', 'Instruct', [
        textCompletionField('instruct_input_sequence', 'User Message Prefix'),
        textCompletionField('instruct_input_suffix', 'User Message Suffix'),
        textCompletionField('instruct_first_input_sequence', 'First User Prefix'),
        textCompletionField('instruct_last_input_sequence', 'Last User Prefix'),
    ], { enabledBy: 'instruct_enabled' }),
    textCompletionEntry('tc-assistant', 'Assistant', 'Instruct', [
        textCompletionField('instruct_output_sequence', 'Assistant Message Prefix'),
        textCompletionField('instruct_output_suffix', 'Assistant Message Suffix'),
        textCompletionField('instruct_first_output_sequence', 'First Assistant Prefix'),
        textCompletionField('instruct_last_output_sequence', 'Last Assistant Prefix'),
    ], { enabledBy: 'instruct_enabled' }),
    textCompletionEntry('tc-system', 'System', 'Instruct', [
        textCompletionField('instruct_system_sequence', 'System Message Prefix'),
        textCompletionField('instruct_system_suffix', 'System Message Suffix'),
        textCompletionField('instruct_system_same_as_user', 'System same as User'),
        textCompletionField('instruct_last_system_sequence', 'System Instruction Prefix'),
    ], { enabledBy: 'instruct_enabled' }),
    textCompletionEntry('tc-misc', 'Misc', 'Instruct', [
        textCompletionField('instruct_story_string_prefix', 'Story String Prefix'),
        textCompletionField('instruct_story_string_suffix', 'Story String Suffix'),
        textCompletionField('instruct_stop_sequence', 'Stop Sequence'),
        textCompletionField('instruct_user_alignment_message', 'User Filler Message'),
    ], { enabledBy: 'instruct_enabled' }),
]);

// Keep upstream form handlers as the write boundary, including quick-edit aliases and variable cleanup.
export function createPromptEditorModel(manager = promptManager) {
    function scope() {
        return JSON.stringify([manager.configuration.promptOrder.strategy, manager.activeCharacter?.id, manager.serviceSettings?.preset_settings_openai]);
    }

    function requireScope(expected) {
        if (expected !== scope()) throw new Error('The prompt editor context changed before this operation completed.');
    }

    function requirePrompt(identifier) {
        const prompt = manager.getPromptById(identifier);
        if (!prompt) throw new Error(`Prompt not found: ${identifier}`);
        return prompt;
    }

    function rowEvent(identifier) {
        const target = document.createElement('div');
        target.className = `${manager.configuration.prefix}prompt_manager_prompt`;
        target.dataset.pmIdentifier = identifier;
        return { target, preventDefault() {}, stopPropagation() {} };
    }

    function field(suffix) {
        const element = document.getElementById(`${manager.configuration.prefix}prompt_manager_${suffix}`);
        if (!element) throw new Error(`Prompt Manager field is missing: ${suffix}`);
        return element;
    }

    function utilityField(identifier) {
        if (!PROMPT_EDITOR_UTILITY_FIELDS.some(([id]) => id === identifier)) throw new Error(`Unknown utility prompt: ${identifier}`);
        const element = document.getElementById(identifier);
        if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Utility prompt field is missing: ${identifier}`);
        return element;
    }

    function textCompletionControl(identifier) {
        if (!PROMPT_EDITOR_TEXT_COMPLETION_ENTRIES.some(entry => [...entry.fields, ...entry.properties].some(field => field.id === identifier))
            && !['sysprompt_enabled', 'instruct_enabled'].includes(identifier)) {
            throw new Error(`Unknown Text Completions editor field: ${identifier}`);
        }
        const control = document.getElementById(identifier);
        if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) {
            throw new Error(`Text Completions editor field is missing: ${identifier}`);
        }
        return control;
    }

    function readTextCompletionValue(identifier) {
        const control = textCompletionControl(identifier);
        return control instanceof HTMLInputElement && control.type === 'checkbox' ? control.checked : control.value;
    }

    function readTextCompletionEntry(entry) {
        return {
            ...entry,
            identifier: entry.id,
            values: Object.fromEntries(entry.fields.map(({ id }) => [id, readTextCompletionValue(id)])),
            propertyValues: Object.fromEntries(entry.properties.map(({ id }) => [id, readTextCompletionValue(id)])),
            disabled: entry.enabledBy ? !readTextCompletionValue(entry.enabledBy) : false,
        };
    }

    function textCompletionScope() {
        return JSON.stringify([
            document.getElementById('main_api')?.value ?? '',
            ...['sysprompt_select', 'instruct_presets', 'context_presets'].map(id => document.getElementById(id)?.value ?? ''),
        ]);
    }

    function writeTextCompletionValue(identifier, value) {
        const control = textCompletionControl(identifier);
        const isCheckbox = control instanceof HTMLInputElement && control.type === 'checkbox';
        const nextValue = isCheckbox ? Boolean(value) : String(value ?? '');
        const currentValue = isCheckbox ? control.checked : control.value;
        if (currentValue === nextValue) return;
        if (isCheckbox) control.checked = nextValue;
        else control.value = nextValue;
        control.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function refresh() {
        manager.render(false);
    }

    function persist() {
        refresh();
        return manager.saveServiceSettings();
    }

    function permissions(prompt) {
        return {
            edit: manager.isPromptEditAllowed(prompt),
            rename: !prompt.marker && manager.isPromptEditAllowed(prompt),
            toggle: manager.isPromptToggleAllowed(prompt),
            remove: prompt.system_prompt === false,
            delete: manager.isPromptDeletionAllowed(prompt),
            reset: Object.hasOwn(RESET_NAMES, prompt.identifier),
        };
    }

    return {
        scope,
        permissions,
        refresh,
        snapshot() {
            if (!manager?.serviceSettings) return null;
            return {
                scope: scope(),
                prompts: manager.serviceSettings.prompts,
                order: manager.getPromptOrderForCharacter(manager.activeCharacter),
                character: manager.activeCharacter,
                strategy: manager.configuration.promptOrder.strategy,
                counts: manager.getActivePromptTokenCounts(),
                tokens: manager.getDisplayTokenUsage(),
                sources: manager.promptSources,
                error: manager.error,
                runtime: { identifier: RUNTIME_AGENTS_IDENTIFIER, name: 'In-Chat Agents', marker: true, runtime: true },
            };
        },
        snapshotTextCompletions() {
            return {
                type: 'text-completions',
                scope: textCompletionScope(),
                textCompletionEntries: PROMPT_EDITOR_TEXT_COMPLETION_ENTRIES.map(readTextCompletionEntry),
            };
        },
        readTextCompletionEntry(identifier) {
            const entry = PROMPT_EDITOR_TEXT_COMPLETION_ENTRIES.find(candidate => candidate.id === identifier);
            if (!entry) throw new Error(`Text Completions editor entry is missing: ${identifier}`);
            return readTextCompletionEntry(entry);
        },
        textCompletionScope,
        saveTextCompletion(draft, expectedScope) {
            if (expectedScope !== textCompletionScope()) throw new Error('The Text Completions preset context changed before this edit was saved.');
            const entry = PROMPT_EDITOR_TEXT_COMPLETION_ENTRIES.find(candidate => candidate.id === draft.identifier);
            if (!entry) throw new Error(`Text Completions editor entry is missing: ${draft.identifier}`);
            for (const { id } of entry.fields) writeTextCompletionValue(id, draft.values[id]);
            for (const { id } of entry.properties) writeTextCompletionValue(id, draft.propertyValues[id]);
        },
        newDraft() {
            return { identifier: manager.getUuidv4(), name: '', role: 'system', content: '', system_prompt: false, marker: false, injection_position: 0, injection_depth: 4, injection_order: 100, injection_trigger: [], forbid_overrides: false };
        },
        save(draft, expectedScope) {
            requireScope(expectedScope);
            const existing = manager.getPromptById(draft.identifier);
            if (existing && !manager.isPromptEditAllowed(existing)) throw new Error('This prompt is not editable.');
            if (!['system', 'user', 'assistant'].includes(draft.role ?? 'system')) throw new Error('Unsupported prompt role.');
            if (![0, 1].includes(Number(draft.injection_position ?? 0))) throw new Error('Unsupported prompt injection position.');
            for (const key of ['injection_depth', 'injection_order']) {
                if (draft[key] !== undefined && !Number.isFinite(Number(draft[key]))) throw new Error(`Invalid ${key}.`);
            }
            manager.loadPromptIntoEditForm(existing ?? draft);
            const values = { ...draft, role: draft.role ?? 'system', injection_position: draft.injection_position ?? 0, injection_depth: draft.injection_depth ?? 4, injection_order: draft.injection_order ?? 100 };
            for (const [key, suffix] of Object.entries(EDIT_FIELDS)) {
                field(`popup_entry_form_${suffix}`).value = existing?.marker && key === 'content' ? existing.content ?? '' : values[key] ?? '';
            }
            field('popup_entry_form_forbid_overrides').checked = Boolean(draft.forbid_overrides);
            const triggerField = field('popup_entry_form_injection_trigger');
            for (const option of triggerField.options) option.selected = (draft.injection_trigger ?? []).includes(option.value);
            field('popup_entry_form_prompt').dispatchEvent(new Event('input', { bubbles: true }));
            manager.handleSavePrompt({ currentTarget: { dataset: { pmPrompt: draft.identifier } } });
        },
        rename(identifier, name, expectedScope) {
            const prompt = requirePrompt(identifier);
            if (!permissions(prompt).rename) return;
            this.save({ ...prompt, name }, expectedScope);
        },
        resetDraft(draft) {
            if (!Object.hasOwn(RESET_NAMES, draft.identifier)) return draft;
            return { ...draft, name: RESET_NAMES[draft.identifier], content: manager.configuration.defaultPrompts[draft.identifier], role: 'system', injection_trigger: [], forbid_overrides: ['main', 'jailbreak'].includes(draft.identifier) ? false : draft.forbid_overrides };
        },
        toggle(identifier, expectedScope) {
            requireScope(expectedScope);
            const prompt = requirePrompt(identifier);
            if (!manager.activeCharacter || !permissions(prompt).toggle || !manager.getPromptOrderEntry(manager.activeCharacter, identifier)) return;
            manager.handleToggle(rowEvent(identifier));
        },
        insert(identifier, expectedScope) {
            requireScope(expectedScope);
            if (!manager.activeCharacter) return;
            manager.appendPrompt(requirePrompt(identifier), manager.activeCharacter);
            return persist();
        },
        remove(identifier, expectedScope) {
            requireScope(expectedScope);
            const prompt = requirePrompt(identifier);
            if (!manager.activeCharacter || !permissions(prompt).remove) return null;
            const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
            const index = order.findIndex(entry => entry.identifier === identifier);
            if (index < 0) return null;
            const removed = { index, entry: { ...order[index] }, scope: expectedScope };
            manager.handleDetach(rowEvent(identifier));
            return removed;
        },
        undoRemove(removed) {
            requireScope(removed.scope);
            requirePrompt(removed.entry.identifier);
            const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
            if (order.some(entry => entry.identifier === removed.entry.identifier)) return;
            order.splice(Math.min(removed.index, order.length), 0, removed.entry);
            return persist();
        },
        delete(identifier, expectedScope) {
            requireScope(expectedScope);
            const prompt = requirePrompt(identifier);
            if (!permissions(prompt).delete) return;
            manager.serviceSettings.prompts.splice(manager.getPromptIndexById(identifier), 1);
            // Upstream deletion keeps order references; missing definitions are skipped on render.
            return persist();
        },
        reorder(identifiers, expectedScope) {
            requireScope(expectedScope);
            if (!manager.activeCharacter) return;
            const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
            const visible = order.filter(entry => manager.getPromptById(entry.identifier));
            if (new Set(identifiers).size !== visible.length || identifiers.some(id => !visible.some(entry => entry.identifier === id))) throw new Error('The displayed prompt order is stale.');
            const reordered = reorderPromptOrder(order, identifiers);
            manager.removePromptOrderForCharacter(manager.activeCharacter);
            manager.addPromptOrderForCharacter(manager.activeCharacter, reordered);
            return persist();
        },
        sendToAgents(identifier) {
            const prompt = requirePrompt(identifier);
            if (!prompt.marker) manager.handleSendToAgents(rowEvent(identifier));
        },
        readUtility: identifier => utilityField(identifier).value,
        canRestoreUtility: identifier => Boolean(document.getElementById(identifier.replace(/_textarea$/, '_restore'))),
        saveUtility(draft, expectedScope) {
            requireScope(expectedScope);
            const field = utilityField(draft.identifier);
            field.value = draft.content;
            // Native events also reach PresetManager's dirty guard; jQuery.trigger only reaches its controller.
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
        },
        restoreUtility(identifier, expectedScope) {
            requireScope(expectedScope);
            utilityField(identifier);
            const control = document.getElementById(identifier.replace(/_textarea$/, '_restore'));
            if (!control) throw new Error(`Utility prompt has no restore action: ${identifier}`);
            control.click();
        },
        preview(draft) {
            const rendered = draft.marker ? getRenderedMarkerPrompt(draft.identifier, manager.messages) : null;
            return rendered?.content || manager.preparePrompt(draft).content || '';
        },
        inspect(identifier) {
            const messages = identifier === RUNTIME_AGENTS_IDENTIFIER ? manager.runtimeAgentMessages : manager.messages?.getItemByIdentifier(identifier);
            if (!messages) return [];
            const flatten = item => typeof item.flatten === 'function' ? item.flatten() : typeof item.getCollection === 'function' ? item.getCollection().flatMap(flatten) : [item];
            return flatten(messages).map(message => ({ role: message.role, content: message.content ?? '', name: message.displayName || message.identifier || '', tokens: message.getTokens() }));
        },
        importList: () => manager.handleImport(),
        exportList: () => manager.handleFullExport(),
        exportCharacter: () => manager.handleCharacterExport(),
        resetOrder: () => manager.handleCharacterReset(),
    };
}
