export function agentFixture(overrides = {}) {
    return {
        id: 'qa-agent',
        name: 'QA Agent',
        description: 'Original description',
        icon: 'fa-puzzle-piece',
        category: 'custom',
        execution: 'inline',
        tags: ['original'],
        version: 4,
        author: 'QA',
        prompt: '  Preserve {{char}} and whitespace\n',
        phase: 'pre',
        connectionProfile: 'missing-profile',
        modelOverride: 'missing-model',
        sourceTemplateId: '',
        enabled: true,
        favorite: false,
        phaseLocked: false,
        regexScripts: [],
        tools: [],
        settings: {},
        ...overrides,
        injection: {
            position: 1,
            depth: 1,
            role: 0,
            order: 100,
            scan: false,
            ...overrides.injection,
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
            ...overrides.preProcess,
        },
        postProcess: {
            enabled: false,
            type: 'extract',
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
            ...overrides.postProcess,
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
            batch: false,
            batchAgentIds: [],
            sendContextToCompanions: false,
            contextRecipientAgentIds: [],
            dependencies: [],
            waitForDependencies: false,
            maxTokens: 64000,
            ...overrides.companion,
            feedback: {
                enabled: false,
                depth: 1,
                ...overrides.companion?.feedback,
            },
        },
        conditions: {
            triggerKeywords: [],
            triggerProbability: 100,
            generationTypes: ['normal', 'continue', 'impersonate'],
            runOnImpersonate: false,
            runOnCompanionOutputs: false,
            companionOutputTargetAgentIds: [],
            ...overrides.conditions,
        },
    };
}

export function regexFixture(overrides = {}) {
    return {
        id: 'qa-regex',
        scriptName: 'QA Regex',
        findRegex: '/(tracker)/gi',
        replaceString: ' $1\n',
        trimStrings: ['prefix', 'suffix'],
        placement: [0, 1, 2, 3, 5, 6],
        substituteRegex: 2,
        minDepth: -1,
        maxDepth: 23,
        markdownOnly: false,
        promptOnly: true,
        runOnEdit: false,
        disabled: true,
        extension: { retained: true },
        ...overrides,
    };
}

export function toolFixture() {
    return {
        name: 'QA_Search',
        displayName: 'QA Search',
        description: 'Tool instructions',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
        },
        actionKey: 'qa.search',
        formatMessageKey: 'qa.format',
        shouldRegister: false,
        stealth: true,
        enabled: false,
    };
}

export function freezeFixture(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freezeFixture);
    return Object.freeze(value);
}

export function readPath(value, path) {
    return path.split('.').reduce((parent, key) => parent[key], value);
}

export function writePath(value, path, next) {
    const keys = path.split('.');
    const parent = keys.slice(0, -1).reduce((object, key) => object[key], value);
    parent[keys.at(-1)] = next;
}
