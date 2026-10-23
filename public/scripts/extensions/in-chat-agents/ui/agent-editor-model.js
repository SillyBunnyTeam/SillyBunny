// SillyBunny: detached editor boundary; deliberately does not import the browser-backed store.
const defaults = {
    name: '',
    description: '',
    icon: '',
    category: 'custom',
    execution: 'inline',
    tags: [],
    version: 1,
    author: '',
    prompt: '',
    phase: 'pre',
    connectionProfile: '',
    modelOverride: '',
    sourceTemplateId: '',
    injection: {
        position: 1,
        depth: 1,
        role: 0,
        order: 100,
        scan: false,
    },
    preProcess: {
        mode: 'inject',
        interceptTiming: 'pre-generation',
        applyMode: 'replace',
        wrapPosition: 'after',
        wrapPrefix: '',
        wrapSuffix: '',
        patchStartTag: '<context_patch>',
        patchEndTag: '</context_patch>',
        maxTokens: 8192,
    },
    postProcess: {
        enabled: false,
        type: 'regex',
        regexFind: '',
        regexReplace: '',
        regexFlags: 'g',
        appendText: '',
        extractPattern: '',
        extractVariable: '',
        promptTransformEnabled: false,
        promptTransformShowNotifications: true,
        promptTransformMode: 'rewrite',
        promptTransformMaxTokens: 8192,
    },
    companion: {
        trigger: 'auto',
        displayMode: 'panel',
        format: 'markdown',
        rawPrompt: false,
        inlinePhase: '',
        minContextTokens: 0,
        contextMessages: 10,
        includeCharacterCard: true,
        includePersona: true,
        includeWorldInfo: true,
        includeAuthorsNote: true,
        includeSystemPrompt: true,
        includeHistory: true,
        includeInChatHistory: false,
        chatHistoryDepth: 1,
        includeAllChatHistory: true,
        keepInChatHistoryWhenHostHidden: false,
        historyDepth: 3,
        feedback: {
            enabled: false,
            depth: 1,
        },
        batch: false,
        batchAgentIds: [],
        sendContextToCompanions: false,
        contextRecipientAgentIds: [],
        dependencies: [],
        waitForDependencies: false,
        maxTokens: 64000,
    },
    regexScripts: [],
    enabled: false,
    favorite: false,
    phaseLocked: false,
    conditions: {
        triggerKeywords: [],
        triggerProbability: 100,
        generationTypes: ['normal', 'continue', 'impersonate'],
        runOnImpersonate: false,
        runOnCompanionOutputs: false,
        companionOutputTargetAgentIds: [],
    },
    tools: [],
    settings: {},
};

function fillDefaults(base, input) {
    const result = structuredClone(input);
    for (const [key, value] of Object.entries(base)) {
        if (result[key] === undefined) result[key] = structuredClone(value);
        else if (value && typeof value === 'object' && !Array.isArray(value)) result[key] = fillDefaults(value, result[key] ?? {});
    }
    return result;
}

export function createAgentEditorState(agent) {
    const fields = fillDefaults(defaults, agent);
    if (fields.category === 'companion') fields.execution = 'companion';
    return {
        fields,
        trackerBuilder: {
            format: '',
            rules: '',
            style: '',
        },
    };
}

function parseNumbers(fields, base = defaults) {
    for (const [key, value] of Object.entries(base)) {
        if (typeof value === 'number') {
            const parsed = Number(fields[key]);
            fields[key] = Number.isFinite(parsed) ? parsed : value;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) parseNumbers(fields[key], value);
    }
}

export function serializeAgentEditorState(original, state, { template = null } = {}) {
    const fields = createAgentEditorState(state.fields).fields;
    parseNumbers(fields);
    for (const key of ['name', 'description', 'modelOverride']) fields[key] = String(fields[key]).trim();
    fields.name ||= 'Untitled Agent';
    fields.preProcess.patchStartTag ||= '<context_patch>';
    fields.preProcess.patchEndTag ||= '</context_patch>';
    fields.preProcess.maxTokens ||= defaults.preProcess.maxTokens;
    fields.postProcess.promptTransformMaxTokens ||= defaults.postProcess.promptTransformMaxTokens;
    const baseline = createAgentEditorState(original).fields;
    if (JSON.stringify(fields) !== JSON.stringify(baseline) && (fields.sourceTemplateId || template?.id)) {
        fields.sourceTemplateId ||= template.id;
        fields.phaseLocked = true;
    }
    return fields;
}

export function getAgentEditorVisibility(agent) {
    const f = createAgentEditorState(agent).fields;
    const companion = f.execution === 'companion';
    const before = !companion && f.phase !== 'post';
    const intercept = before && f.preProcess.mode === 'intercept';
    const after = !companion && f.phase !== 'pre';
    const feedback = companion && f.companion.feedback.enabled;
    const utility = after && f.postProcess.enabled;
    const pass = after && f.postProcess.promptTransformEnabled;
    const chatroom = companion && f.sourceTemplateId === 'tpl-chatroom-companion';
    const director = companion && f.sourceTemplateId === 'tpl-directors-commentary-companion';
    const plot = companion && f.sourceTemplateId === 'tpl-plot-compass-companion';
    const groups = ['general', 'prompt'];
    if (companion) groups.push(
        'companion-output',
        'companion-context',
        'companion-chat-history',
        'companion-feedback',
        'companion-coordination',
    );
    if (chatroom || director || plot) groups.push('template-options');
    if (f.category === 'tracker') groups.push('tracker-builder');
    if (before || feedback) groups.push('before');
    if (after) groups.push('after');
    groups.push('regex', 'conditions');
    return {
        groups,
        fields: {
            phase: !companion,
            injection: before || feedback,
            preProcess: before,
            'injection.order': true,
            'preProcess.interceptTiming': intercept,
            'preProcess.applyMode': intercept,
            'preProcess.maxTokens': intercept,
            'preProcess.wrapPosition': intercept && f.preProcess.applyMode !== 'replace',
            'preProcess.wrapPrefix': intercept && f.preProcess.applyMode === 'wrap',
            'preProcess.wrapSuffix': intercept && f.preProcess.applyMode === 'wrap',
            'preProcess.patchStartTag': intercept && f.preProcess.applyMode === 'patch',
            'preProcess.patchEndTag': intercept && f.preProcess.applyMode === 'patch',
            'postProcess.promptTransformMode': pass,
            'postProcess.promptTransformMaxTokens': pass,
            'postProcess.promptTransformShowNotifications': pass,
            'postProcess.type': utility,
            'postProcess.extractPattern': utility && f.postProcess.type === 'extract',
            'postProcess.extractVariable': utility && f.postProcess.type === 'extract',
            'postProcess.appendText': utility && f.postProcess.type === 'append',
            'conditions.companionOutputTargetAgentIds': after && f.conditions.runOnCompanionOutputs,
            'companion.feedback.depth': companion && f.companion.feedback.enabled,
            'companion.historyDepth': companion && f.companion.includeHistory,
            'companion.chatHistoryDepth': companion && f.companion.includeInChatHistory,
            'companion.includeAllChatHistory': companion && f.companion.includeInChatHistory,
            'companion.keepInChatHistoryWhenHostHidden': companion && f.companion.includeInChatHistory,
            'companion.batchAgentIds': companion && f.companion.batch,
            'companion.contextRecipientAgentIds': companion && f.companion.sendContextToCompanions,
            'settings.chatroomStyle': chatroom,
            'settings.chatroomCustomStyleName': chatroom && f.settings.chatroomStyle === 'custom',
            'settings.chatroomCustomStyles': chatroom && f.settings.chatroomStyle === 'custom',
            'settings.chatroomExtraCharacterAvatars': chatroom,
            'settings.directorCommentaryVoice': director,
            'settings.directorCommentaryCustomVoiceName': director && f.settings.directorCommentaryVoice === 'custom',
            'settings.directorCommentaryCustomVoices': director && f.settings.directorCommentaryVoice === 'custom',
            'settings.plotCompassObjective': plot,
        },
        disabled: {
            execution: f.category === 'companion',
            'companion.chatHistoryDepth': f.companion.includeAllChatHistory,
        },
    };
}

export function validateAgentEditorState({ fields: f }) {
    if (String(f.prompt ?? '').trim()) return [];
    if (f.execution === 'companion' || f.category === 'companion') return [{
        field: 'prompt',
        code: 'companion-prompt-required',
    }];
    if (f.phase !== 'post' && f.preProcess.mode === 'intercept') return [{
        field: 'prompt',
        code: 'intercept-prompt-required',
    }];
    if (f.postProcess.promptTransformEnabled) return [{
        field: 'prompt',
        code: 'prompt-pass-required',
    }];
    return [];
}

export function validateAgentRegexScript(script) {
    return String(script.findRegex ?? '').trim() ? [] : [{
        field: 'findRegex',
        code: 'find-required',
    }];
}
