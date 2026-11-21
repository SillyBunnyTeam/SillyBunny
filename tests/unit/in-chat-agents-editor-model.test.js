/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- DOM-free Jest model contracts. */
import { describe, expect, test } from '@jest/globals';
import { agentFixture, freezeFixture, readPath, regexFixture, toolFixture, writePath } from '../fixtures/in-chat-agents-editor.js';

const CHATROOM = 'tpl-chatroom-companion';
const DIRECTOR = 'tpl-directors-commentary-companion';
const PLOT = 'tpl-plot-compass-companion';
const loadModel = () => import('../../public/scripts/extensions/in-chat-agents/ui/agent-editor-model.js');

const variants = [
    ['pre', {}],
    ['both', { phase: 'both' }],
    ['post', { phase: 'post' }],
    [
        'intercept wrap',
        {
            preProcess: {
                mode: 'intercept',
                applyMode: 'wrap',
                wrapPrefix: ' \n[',
                wrapSuffix: ']\n ',
                wrapPosition: 'before',
            },
        },
    ],
    [
        'intercept patch',
        {
            phase: 'both',
            preProcess: {
                mode: 'intercept',
                applyMode: 'patch',
                interceptTiming: 'post-main-generation',
                patchStartTag: '<qa>',
                patchEndTag: '</qa>',
            },
        },
    ],
    ...['card', 'panel', 'hidden'].map(displayMode => [
        `companion ${displayMode}`,
        {
            category: 'companion',
            execution: 'companion',
            phase: 'post',
            companion: { displayMode },
        },
    ]),
    [
        'Chatroom preset',
        {
            category: 'companion',
            execution: 'companion',
            sourceTemplateId: CHATROOM,
            settings: { chatroomStyle: 'reddit' },
        },
    ],
    [
        'Chatroom custom',
        {
            execution: 'companion',
            sourceTemplateId: CHATROOM,
            settings: {
                chatroomStyle: 'custom',
                chatroomCustomStyleName: 'Radio',
                chatroomCustomStyles: 'Radio: Local callers',
                chatroomExtraCharacterAvatars: ['missing.png'],
            },
        },
    ],
    [
        'Director preset',
        {
            execution: 'companion',
            sourceTemplateId: DIRECTOR,
            settings: { directorCommentaryVoice: 'randomised' },
        },
    ],
    [
        'Director custom',
        {
            execution: 'companion',
            sourceTemplateId: DIRECTOR,
            settings: {
                directorCommentaryVoice: 'custom',
                directorCommentaryCustomVoiceName: 'Noir',
                directorCommentaryCustomVoices: 'Noir: Short asides',
            },
        },
    ],
    [
        'Plot Compass',
        {
            execution: 'companion',
            sourceTemplateId: PLOT,
            settings: { plotCompassObjective: 'Reach the tower' },
        },
    ],
    [
        'tracker',
        {
            category: 'tracker',
            phase: 'both',
            postProcess: {
                enabled: true,
                type: 'extract',
                extractPattern: '\\[TRACKER\\]',
                extractVariable: 'tracker',
            },
            regexScripts: [regexFixture()],
        },
    ],
    ['tool', {
        category: 'tool',
        tools: [toolFixture()],
        settings: { searchDepth: 9 },
    }],
];

const fieldEdits = [
    ['name', '  Renamed  ', 'Renamed'],
    ['description', '  Detail  ', 'Detail'],
    ['category', 'randomizer', 'randomizer'],
    ['phase', 'both', 'both'],
    ['execution', 'companion', 'companion'],
    ['favorite', true, true],
    ['connectionProfile', 'unavailable-profile', 'unavailable-profile'],
    ['modelOverride', '  qa-model  ', 'qa-model'],
    ['prompt', ' \n{{user}}\n ', ' \n{{user}}\n '],
    ['injection.position', '2', 2],
    ['injection.depth', '17', 17],
    ['injection.role', '2', 2],
    ['injection.order', '321', 321],
    ['injection.scan', true, true],
    ['preProcess.mode', 'intercept', 'intercept'],
    ['preProcess.interceptTiming', 'post-main-generation', 'post-main-generation'],
    ['preProcess.applyMode', 'patch', 'patch'],
    ['preProcess.wrapPosition', 'before', 'before'],
    ['preProcess.wrapPrefix', '\n before ', '\n before '],
    ['preProcess.wrapSuffix', ' after\n', ' after\n'],
    ['preProcess.patchStartTag', '<qa>', '<qa>'],
    ['preProcess.patchEndTag', '</qa>', '</qa>'],
    ['preProcess.maxTokens', '12345', 12345],
    ['postProcess.enabled', true, true],
    ['postProcess.type', 'append', 'append'],
    ['postProcess.extractPattern', '/qa/g', '/qa/g'],
    ['postProcess.extractVariable', 'qa_state', 'qa_state'],
    ['postProcess.appendText', '\n appended ', '\n appended '],
    ['postProcess.promptTransformEnabled', true, true],
    ['postProcess.promptTransformShowNotifications', false, false],
    ['postProcess.promptTransformMode', 'append', 'append'],
    ['postProcess.promptTransformMaxTokens', '23456', 23456],
    ['companion.trigger', 'manual', 'manual'],
    ['companion.displayMode', 'hidden', 'hidden'],
    ['companion.format', 'html', 'html'],
    ['companion.maxTokens', '34567', 34567],
    ['companion.contextMessages', '201', 201],
    ['companion.minContextTokens', '12000', 12000],
    ['companion.includeCharacterCard', false, false],
    ['companion.includePersona', false, false],
    ['companion.includeWorldInfo', false, false],
    ['companion.includeAuthorsNote', false, false],
    ['companion.includeSystemPrompt', false, false],
    ['companion.includeHistory', false, false],
    ['companion.historyDepth', '7', 7],
    ['companion.rawPrompt', true, true],
    ['companion.includeInChatHistory', true, true],
    ['companion.chatHistoryDepth', '202', 202],
    ['companion.includeAllChatHistory', false, false],
    ['companion.keepInChatHistoryWhenHostHidden', true, true],
    ['companion.feedback.enabled', true, true],
    ['companion.feedback.depth', '8', 8],
    ['companion.batch', true, true],
    ['companion.batchAgentIds', ['unavailable-batch'], ['unavailable-batch']],
    ['companion.sendContextToCompanions', true, true],
    ['companion.contextRecipientAgentIds', ['unavailable-recipient'], ['unavailable-recipient']],
    ['companion.dependencies', ['unavailable-dependency'], ['unavailable-dependency']],
    ['companion.waitForDependencies', true, true],
    ['conditions.runOnImpersonate', true, true],
    ['conditions.runOnCompanionOutputs', true, true],
    ['conditions.companionOutputTargetAgentIds', ['unavailable-target'], ['unavailable-target']],
    ['conditions.triggerProbability', '37', 37],
    ['conditions.triggerKeywords', ['one, two', '{{char}}'], ['one, two', '{{char}}']],
    ['conditions.generationTypes', ['quiet'], ['quiet']],
    ['regexScripts', [regexFixture()], [regexFixture()]],
];

describe(
    'Agents editor field boundary',
    () => {
        test(
            'exports DOM-free field, visibility and validation seams without booting the app',
            async () => {
                const model = await loadModel();
                expect(typeof globalThis.document).toBe('undefined');
                expect(typeof globalThis.$).toBe('undefined');
                for (const name of [
                    'createAgentEditorState',
                    'serializeAgentEditorState',
                    'getAgentEditorVisibility',
                    'validateAgentEditorState',
                    'validateAgentRegexScript',
                ]) {
                    expect(typeof model[name]).toBe('function');
                }
            },
        );

        test.each(variants)(
            '%s survives populate → serialize without mutation or lost keys',
            async (_name, overrides) => {
                const model = await loadModel();
                const original = freezeFixture(agentFixture(overrides));
                const before = JSON.stringify(original);
                const state = model.createAgentEditorState(original);
                expect(state.fields).toEqual(original);
                expect(state.fields).not.toBe(original);
                expect(state.fields.injection).not.toBe(original.injection);
                expect(model.serializeAgentEditorState(original, state)).toEqual(original);
                expect(JSON.stringify(original)).toBe(before);
            },
        );

        test.each(fieldEdits)(
            '%s binds an edited field to its persisted key, including hidden rows',
            async (path, input, expected) => {
                const model = await loadModel();
                const original = freezeFixture(agentFixture());
                const state = model.createAgentEditorState(original);
                writePath(state.fields, path, input);
                const saved = model.serializeAgentEditorState(original, state);
                expect(readPath(saved, path)).toEqual(expected);
                const reopened = model.createAgentEditorState(saved);
                expect(readPath(reopened.fields, path)).toEqual(expected);
                expect(saved.id).toBe(original.id);
                expect(saved.enabled).toBe(original.enabled);
                expect(saved.tools).toEqual(original.tools);
            },
        );

        test(
            'uses actual store defaults instead of stale HTML defaults',
            async () => {
                const { createAgentEditorState } = await loadModel();
                const {
                    fields,
                    trackerBuilder,
                } = createAgentEditorState({ id: 'new-agent' });
                expect(fields).toMatchObject({
                    category: 'custom',
                    execution: 'inline',
                    phase: 'pre',
                    enabled: false,
                    favorite: false,
                    injection: {
                        position: 1,
                        depth: 1,
                        role: 0,
                        order: 100,
                        scan: false,
                    },
                    preProcess: { maxTokens: 8192 },
                    postProcess: {
                        type: 'regex',
                        promptTransformMaxTokens: 8192,
                        promptTransformShowNotifications: true,
                    },
                    companion: {
                        displayMode: 'panel',
                        maxTokens: 64000,
                        includeAllChatHistory: true,
                        contextMessages: 10,
                        historyDepth: 3,
                    },
                    conditions: {
                        triggerProbability: 100,
                        generationTypes: ['normal', 'continue', 'impersonate'],
                    },
                });
                expect(trackerBuilder).toEqual({
                    format: '',
                    rules: '',
                    style: '',
                });
            },
        );

        test(
            'blank name and patch tags keep existing fallback semantics, not prompt trimming',
            async () => {
                const model = await loadModel();
                const original = agentFixture();
                const state = model.createAgentEditorState(original);
                Object.assign(state.fields, {
                    name: '  ',
                    prompt: ' \n ',
                });
                Object.assign(state.fields.preProcess, {
                    patchStartTag: '',
                    patchEndTag: '',
                });
                expect(model.serializeAgentEditorState(original, state)).toMatchObject({
                    name: 'Untitled Agent',
                    prompt: ' \n ',
                    preProcess: {
                        patchStartTag: '<context_patch>',
                        patchEndTag: '</context_patch>',
                    },
                });
            },
        );

        test(
            'preserves opaque data at every subtree before the existing store normalization boundary',
            async () => {
                const model = await loadModel();
                const opaque = { future: ['kept'] };
                const original = freezeFixture(agentFixture({
                    future: opaque,
                    category: 'tool',
                    tools: [{
                        ...toolFixture(),
                        future: opaque,
                    }],
                    settings: { future: opaque },
                    injection: { future: opaque },
                    preProcess: { future: opaque },
                    postProcess: { future: opaque },
                    conditions: { future: opaque },
                    companion: {
                        inlinePhase: 'both',
                        future: opaque,
                        feedback: { future: opaque },
                    },
                    regexScripts: [regexFixture({ future: opaque })],
                }));
                const state = model.createAgentEditorState(original);
                state.fields.name = 'Changed';
                const saved = model.serializeAgentEditorState(original, state);
                for (const path of [
                    'future',
                    'settings.future',
                    'injection.future',
                    'preProcess.future',
                    'postProcess.future',
                    'conditions.future',
                    'companion.future',
                    'companion.feedback.future',
                    'tools.0.future',
                    'regexScripts.0.future',
                ]) {
                    expect(readPath(saved, path)).toEqual(opaque);
                    expect(readPath(saved, path)).not.toBe(opaque);
                }
                expect(saved.category).toBe('tool');
                expect(saved.tools).toEqual(original.tools);
                expect(saved.companion.inlinePhase).toBe('both');
            },
        );

        test(
            'does not silently migrate hidden legacy regex utility or clear empty generation switches',
            async () => {
                const model = await loadModel();
                const original = agentFixture({
                    postProcess: {
                        type: 'regex',
                        enabled: true,
                        regexFind: 'qa',
                        regexReplace: '$1',
                        regexFlags: 'gi',
                    },
                    conditions: { generationTypes: [] },
                });
                const state = model.createAgentEditorState(original);
                state.fields.description = 'Changed only description';
                const saved = model.serializeAgentEditorState(original, state);
                expect(saved.postProcess).toEqual(original.postProcess);
                expect(saved.conditions.generationTypes).toEqual([]);
            },
        );

        test.each([
            [
                CHATROOM,
                {
                    chatroomStyle: 'custom',
                    chatroomCustomStyles: 'Radio: Local callers',
                    chatroomCustomStyleName: 'Radio',
                    chatroomExtraCharacterAvatars: ['missing.png'],
                },
            ],
            [
                DIRECTOR,
                {
                    directorCommentaryVoice: 'custom',
                    directorCommentaryCustomVoices: 'Noir: Short asides',
                    directorCommentaryCustomVoiceName: 'Noir',
                },
            ],
            [PLOT, { plotCompassObjective: 'Reach the hidden tower' }],
        ])(
            '%s template edits use the original settings keys and keep unrelated settings',
            async (sourceTemplateId, edits) => {
                const model = await loadModel();
                const original = agentFixture({
                    execution: 'companion',
                    sourceTemplateId,
                    settings: { extension: { keep: true } },
                });
                const state = model.createAgentEditorState(original);
                Object.assign(state.fields.settings, edits);
                const saved = model.serializeAgentEditorState(original, state);
                expect(saved.settings).toEqual({
                    extension: { keep: true },
                    ...edits,
                });
                expect(saved.sourceTemplateId).toBe(sourceTemplateId);
                expect(saved.phaseLocked).toBe(true);
            },
        );

        test(
            'keeps inactive template options when execution or style changes',
            async () => {
                const model = await loadModel();
                const original = agentFixture({
                    execution: 'companion',
                    sourceTemplateId: CHATROOM,
                    settings: {
                        chatroomStyle: 'custom',
                        chatroomCustomStyleName: 'Radio',
                        chatroomCustomStyles: 'Radio: Local callers',
                        chatroomExtraCharacterAvatars: ['missing.png'],
                    },
                });
                const state = model.createAgentEditorState(original);
                state.fields.execution = 'inline';
                state.fields.settings.chatroomStyle = 'mixed';
                const saved = model.serializeAgentEditorState(original, state);
                expect(saved.settings).toEqual({
                    ...original.settings,
                    chatroomStyle: 'mixed',
                });
            },
        );

        test.each([
            ['unchanged linked', false, false, true],
            ['edited linked', true, true, true],
            ['already locked', false, true, true],
            ['edited custom', true, false, false],
        ])(
            '%s retains customization-lock semantics',
            async (_label, edited, expectedLock, linked) => {
                const model = await loadModel();
                const original = agentFixture({
                    sourceTemplateId: linked ? 'tpl-qa' : '',
                    phaseLocked: !edited && expectedLock,
                });
                const state = model.createAgentEditorState(original);
                if (edited) state.fields.prompt += 'Edited';
                const saved = model.serializeAgentEditorState(original, state);
                expect(saved.phaseLocked).toBe(expectedLock);
                expect(saved.sourceTemplateId).toBe(original.sourceTemplateId);
                expect(original.phaseLocked).toBe(!edited && expectedLock);
            },
        );

        test(
            'matched template locks an old unlinked agent and tracker notes never persist or lock alone',
            async () => {
                const model = await loadModel();
                const original = agentFixture({ category: 'tracker' });
                const state = model.createAgentEditorState(original);
                state.trackerBuilder = {
                    format: '[QA]',
                    rules: 'rules',
                    style: 'style',
                };
                expect(model.serializeAgentEditorState(original, state, { template: { id: 'tpl-qa' } })).toEqual(original);
                state.fields.name = 'Edited';
                const saved = model.serializeAgentEditorState(original, state, { template: { id: 'tpl-qa' } });
                expect(saved).toMatchObject({
                    sourceTemplateId: 'tpl-qa',
                    phaseLocked: true,
                });
                expect(saved).not.toHaveProperty('trackerBuilder');
            },
        );
    },
);

describe(
    'Agents editor conditional groups',
    () => {
        test.each(['pre', 'both', 'post'])(
            'inline %s shows only matching action groups',
            async phase => {
                const model = await loadModel();
                const visibility = model.getAgentEditorVisibility(agentFixture({ phase }));
                for (const group of ['general', 'prompt', 'regex', 'conditions']) expect(visibility.groups).toContain(group);
                expect(visibility.groups.includes('before')).toBe(phase !== 'post');
                expect(visibility.groups.includes('after')).toBe(phase !== 'pre');
                expect(visibility.groups).not.toContain('companion-output');
                expect(visibility.fields.phase).toBe(true);
            },
        );

        test.each(['pre', 'both', 'post'])(
            'companion %s hides Stage and inline modes, but feedback placement ignores phase',
            async phase => {
                const model = await loadModel();
                const agent = agentFixture({
                    category: 'tracker',
                    execution: 'companion',
                    phase,
                });
                const off = model.getAgentEditorVisibility(agent);
                expect(off.groups).toEqual(expect.arrayContaining([
                    'companion-output',
                    'companion-context',
                    'companion-chat-history',
                    'companion-feedback',
                    'companion-coordination',
                    'tracker-builder',
                ]));
                expect(off.groups).not.toContain('after');
                expect(off.groups).not.toContain('before');
                expect(off.fields.phase).toBe(false);
                expect(off.disabled.execution).toBe(false);
                expect(agent.phase).toBe(phase);
                expect(off.fields['injection.order']).toBe(true);
                expect(off.fields.preProcess).toBe(false);
                expect(off.fields.injection).toBe(false);
                agent.companion.feedback.enabled = true;
                const on = model.getAgentEditorVisibility(agent);
                expect(on.groups).toContain('before');
                expect(on.fields.injection).toBe(true);
                expect(on.fields.preProcess).toBe(false);
                expect(on.fields['companion.feedback.depth']).toBe(true);
            },
        );

        test(
            'companion category forces and locks execution even with an inline persisted value',
            async () => {
                const model = await loadModel();
                const original = agentFixture({
                    category: 'companion',
                    execution: 'inline',
                });
                const state = model.createAgentEditorState(original);
                expect(state.fields.execution).toBe('companion');
                expect(model.getAgentEditorVisibility(state.fields).disabled.execution).toBe(true);
                expect(model.getAgentEditorVisibility(state.fields).fields.phase).toBe(false);
                expect(model.serializeAgentEditorState(original, state).execution).toBe('companion');
                expect(model.serializeAgentEditorState(original, state).phase).toBe(original.phase);
                expect(model.serializeAgentEditorState(original, state).favorite).toBe(original.favorite);
            },
        );

        test.each(['replace', 'wrap', 'patch'])(
            'intercept %s has precise dependent fields',
            async applyMode => {
                const model = await loadModel();
                const { fields } = model.getAgentEditorVisibility(agentFixture({
                    preProcess: {
                        mode: 'intercept',
                        applyMode,
                    },
                }));
                expect(fields['preProcess.interceptTiming']).toBe(true);
                expect(fields['preProcess.wrapPosition']).toBe(applyMode !== 'replace');
                expect(fields['preProcess.wrapPrefix']).toBe(applyMode === 'wrap');
                expect(fields['preProcess.wrapSuffix']).toBe(applyMode === 'wrap');
                expect(fields['preProcess.patchStartTag']).toBe(applyMode === 'patch');
                expect(fields['preProcess.patchEndTag']).toBe(applyMode === 'patch');
            },
        );

        test.each(['extract', 'append'])(
            'post %s utility and prompt-pass switches reveal only their dependents',
            async type => {
                const model = await loadModel();
                const agent = agentFixture({
                    phase: 'post',
                    postProcess: {
                        enabled: true,
                        type,
                        promptTransformEnabled: true,
                    },
                    conditions: { runOnCompanionOutputs: true },
                });
                const on = model.getAgentEditorVisibility(agent).fields;
                expect(on['postProcess.promptTransformMode']).toBe(true);
                expect(on['postProcess.type']).toBe(true);
                expect(on['postProcess.extractPattern']).toBe(type === 'extract');
                expect(on['postProcess.extractVariable']).toBe(type === 'extract');
                expect(on['postProcess.appendText']).toBe(type === 'append');
                expect(on['conditions.companionOutputTargetAgentIds']).toBe(true);
                agent.postProcess.enabled = agent.postProcess.promptTransformEnabled = agent.conditions.runOnCompanionOutputs = false;
                const off = model.getAgentEditorVisibility(agent).fields;
                for (const key of [
                    'postProcess.promptTransformMode',
                    'postProcess.type',
                    'postProcess.extractPattern',
                    'postProcess.appendText',
                    'conditions.companionOutputTargetAgentIds',
                ]) expect(off[key]).toBe(false);
            },
        );

        test(
            'companion switches expose history, batch and recipient controls without clearing values',
            async () => {
                const model = await loadModel();
                const agent = agentFixture({
                    execution: 'companion',
                    companion: { includeHistory: false },
                });
                const off = model.getAgentEditorVisibility(agent);
                for (const key of [
                    'companion.historyDepth',
                    'companion.chatHistoryDepth',
                    'companion.batchAgentIds',
                    'companion.contextRecipientAgentIds',
                ]) expect(off.fields[key]).toBe(false);
                Object.assign(agent.companion, {
                    includeHistory: true,
                    includeInChatHistory: true,
                    batch: true,
                    sendContextToCompanions: true,
                });
                const on = model.getAgentEditorVisibility(agent);
                for (const key of [
                    'companion.historyDepth',
                    'companion.chatHistoryDepth',
                    'companion.batchAgentIds',
                    'companion.contextRecipientAgentIds',
                ]) expect(on.fields[key]).toBe(true);
                expect(on.disabled['companion.chatHistoryDepth']).toBe(true);
                agent.companion.includeAllChatHistory = false;
                expect(model.getAgentEditorVisibility(agent).disabled['companion.chatHistoryDepth']).toBe(false);
            },
        );

        test.each([
            [CHATROOM, 'settings.chatroomCustomStyles', 'chatroomStyle'],
            [DIRECTOR, 'settings.directorCommentaryCustomVoices', 'directorCommentaryVoice'],
        ])(
            '%s custom fields require matching source and companion execution',
            async (id, customField, choice) => {
                const model = await loadModel();
                const agent = agentFixture({
                    execution: 'companion',
                    sourceTemplateId: id,
                    settings: { [choice]: 'custom' },
                });
                expect(model.getAgentEditorVisibility(agent).groups).toContain('template-options');
                expect(model.getAgentEditorVisibility(agent).fields[customField]).toBe(true);
                agent.settings[choice] = choice === 'chatroomStyle' ? 'mixed' : 'active';
                expect(model.getAgentEditorVisibility(agent).fields[customField]).toBe(false);
                agent.execution = 'inline';
                expect(model.getAgentEditorVisibility(agent).groups).not.toContain('template-options');
                agent.execution = 'companion';
                agent.sourceTemplateId = 'tpl-other';
                expect(model.getAgentEditorVisibility(agent).groups).not.toContain('template-options');
            },
        );
    },
);

describe(
    'Agents editor validation before commit',
    () => {
        test.each([
            ['companion', { execution: 'companion' }, 'companion-prompt-required'],
            ['companion category', { category: 'companion' }, 'companion-prompt-required'],
            ['pre intercept', { preProcess: { mode: 'intercept' } }, 'intercept-prompt-required'],
            [
                'both intercept',
                {
                    phase: 'both',
                    preProcess: { mode: 'intercept' },
                },
                'intercept-prompt-required',
            ],
            [
                'post prompt pass',
                {
                    phase: 'post',
                    postProcess: { promptTransformEnabled: true },
                },
                'prompt-pass-required',
            ],
            [
                'hidden prompt pass',
                {
                    phase: 'pre',
                    postProcess: { promptTransformEnabled: true },
                },
                'prompt-pass-required',
            ],
        ])(
            '%s rejects whitespace prompt with a field issue',
            async (_label, overrides, code) => {
                const model = await loadModel();
                const state = model.createAgentEditorState(agentFixture({
                    ...overrides,
                    prompt: ' \n\t',
                }));
                expect(model.validateAgentEditorState(state)).toContainEqual({
                    field: 'prompt',
                    code,
                });
            },
        );

        test.each([
            ['inject', {}],
            ['regex only', {
                phase: 'post',
                regexScripts: [regexFixture()],
            }],
            [
                'utility only',
                {
                    phase: 'post',
                    postProcess: {
                        enabled: true,
                        type: 'append',
                        appendText: 'qa',
                    },
                },
            ],
            ['inactive intercept', {
                phase: 'post',
                preProcess: { mode: 'intercept' },
            }],
        ])(
            '%s permits empty prompt',
            async (_label, overrides) => {
                const model = await loadModel();
                expect(model.validateAgentEditorState(model.createAgentEditorState(agentFixture({
                    ...overrides,
                    prompt: '',
                })))).toEqual([]);
            },
        );

        test(
            'regex validation rejects blank Find before any dialog result can be committed',
            async () => {
                const model = await loadModel();
                const invalid = freezeFixture(regexFixture({ findRegex: ' \n ' }));
                expect(model.validateAgentRegexScript(invalid)).toEqual([{
                    field: 'findRegex',
                    code: 'find-required',
                }]);
                expect(model.validateAgentRegexScript(regexFixture())).toEqual([]);
                expect(invalid.findRegex).toBe(' \n ');
            },
        );
    },
);
