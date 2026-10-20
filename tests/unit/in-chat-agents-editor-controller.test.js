/** @jest-environment jsdom */
/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest controller/session tests use jsdom, not Playwright. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { deserialize, serialize } from 'node:v8';
import { agentFixture } from '../fixtures/in-chat-agents-editor.js';

const popupShow = jest.fn();
await jest.unstable_mockModule(
    '../../public/scripts/popup.js',
    () => ({
        POPUP_TYPE: { CONFIRM: 'confirm' },
        POPUP_RESULT: {
            AFFIRMATIVE: 1,
            NEGATIVE: 0,
        },
        Popup: jest.fn().mockImplementation(function () {
            this.okButton = document.createElement('button');
            this.show = popupShow;
        }),
    }),
);
await jest.unstable_mockModule(
    '../../public/scripts/i18n.js',
    () => ({
        t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
    }),
);
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({ isActionMenuOpen: () => false }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({ isPickerOpen: () => false }));

const loadController = () => import('../../public/scripts/extensions/in-chat-agents/ui/agent-editor-controller.js');
const mounted = new Set();
const unregisters = new Set();

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

async function mount(options = {}) {
    const module = await loadController();
    const { confirmEditorLeave } = await import('../../public/scripts/sillybunny-editor/navigation.js');
    const events = [];
    const services = {
        saveAgent: jest.fn(async agent => {
            events.push('save');
            return structuredClone(agent);
        }),
        materialise: jest.fn(async (_id, { edits }) => {
            events.push('materialise');
            return {
                ...structuredClone(edits),
                id: 'saved-catalogue',
            };
        }),
        syncCompanionChatHistoryConfig: jest.fn(async () => {
            events.push('history');
            return 0;
        }),
        saveChatDebounced: jest.fn(() => events.push('chat')),
        refreshRegexSnapshotsForAgent: jest.fn(() => events.push('regex')),
        refreshList: jest.fn(() => events.push('list')),
        updateCompanionButtonVisibility: jest.fn(() => events.push('buttons')),
        confirmLeave: jest.fn(registration => confirmEditorLeave(registration)),
        ...options.services,
    };
    const recovery = [];
    const onStateChange = jest.fn();
    const controller = module.createAgentEditorController({
        agent: agentFixture(),
        userHandle: 'qa-user',
        storage: localStorage,
        offerDraft: (draft, actions) => recovery.push({
            draft,
            actions,
        }),
        onStateChange,
        ...options,
        services,
    });
    mounted.add(controller);
    return {
        module,
        controller,
        services,
        recovery,
        events,
        onStateChange,
    };
}

async function settle() {
    await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    popupShow.mockReset().mockResolvedValue(0);
    document.body.replaceChildren();
    localStorage.clear();
    globalThis.structuredClone ??= value => deserialize(serialize(value));
});

afterEach(() => {
    for (const unregister of unregisters) unregister();
    unregisters.clear();
    for (const controller of mounted) controller.destroy();
    mounted.clear();
    jest.restoreAllMocks();
    jest.useRealTimers();
});

describe(
    'Agents editor explicit-save controller',
    () => {
        test.each(['custom', 'companion', 'tracker', 'tool'])(
            '%s property-bar edits use the existing keys and retain hidden Stage through Save',
            async category => {
                const { controller, services } = await mount({ agent: agentFixture({ category }) });
                controller.update('phase', 'both');
                controller.update('favorite', true);
                controller.update('execution', 'companion');
                if (category === 'companion') controller.update('execution', 'inline');
                expect(controller.getState().fields).toMatchObject({ category, phase: 'both', execution: 'companion', favorite: true });
                expect(services.saveAgent).not.toHaveBeenCalled();
                await controller.save();
                expect(services.saveAgent).toHaveBeenCalledTimes(1);
                expect(services.saveAgent.mock.calls[0][0]).toMatchObject({
                    category,
                    phase: 'both',
                    execution: 'companion',
                    favorite: true,
                });
                expect(controller.isDirty()).toBe(false);
            },
        );

        test(
            'exports a controller and user-scoped draft-key function',
            async () => {
                const module = await loadController();
                expect(typeof module.createAgentEditorController).toBe('function');
                expect(typeof module.agentEditorDraftKey).toBe('function');
                expect(module.agentEditorDraftKey('qa-user', 'agent:qa/id')).toBe('sb-agent-editor-draft-qa-user-agent%3Aqa%2Fid');
                expect(module.agentEditorDraftKey('', 'new-agent')).toBe('sb-agent-editor-draft-default-new-agent');
                expect(module.agentEditorDraftKey('alice', 'agent:qa')).not.toBe(module.agentEditorDraftKey('bob', 'agent:qa'));
                expect(module.agentEditorDraftKey('alice', 'agent:qa')).not.toBe(module.agentEditorDraftKey('alice', 'agent-template:qa'));
            },
        );

        test(
            'opening and editing are read-only until Save, with exact dirty checks and detached snapshots',
            async () => {
                const original = agentFixture();
                const {
                    controller,
                    services,
                } = await mount({ agent: original });
                expect(controller.isOpen()).toBe(true);
                expect(controller.isDirty()).toBe(false);
                expect(controller.getState()).toMatchObject({
                    key: 'agent:qa-agent',
                    dirty: false,
                    saving: false,
                    errors: [],
                });
                const snapshot = controller.getState();
                snapshot.fields.name = 'Cannot mutate the controller';
                expect(controller.getState().fields.name).toBe(original.name);
                controller.update('name', 'Edited');
                expect(controller.isDirty()).toBe(true);
                expect(original.name).toBe('QA Agent');
                expect(services.saveAgent).not.toHaveBeenCalled();
                expect(services.materialise).not.toHaveBeenCalled();
            },
        );

        test.each([
            ['companion', { execution: 'companion' }],
            ['intercept', { preProcess: { mode: 'intercept' } }],
            ['hidden prompt pass', { postProcess: { promptTransformEnabled: true } }],
        ])(
            '%s validation fails before commit and keeps the editor/draft open',
            async (_label, overrides) => {
                const {
                    controller,
                    services,
                    module,
                } = await mount({ agent: agentFixture(overrides) });
                controller.update('prompt', ' \n ');
                controller.flushDraft();
                const key = module.agentEditorDraftKey('qa-user', 'agent:qa-agent');
                expect(await controller.save()).toBe(false);
                expect(controller.isOpen()).toBe(true);
                expect(controller.isDirty()).toBe(true);
                expect(controller.getState().errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'prompt' })]));
                expect(localStorage.getItem(key)).not.toBeNull();
                for (const name of [
                    'saveAgent',
                    'materialise',
                    'syncCompanionChatHistoryConfig',
                    'refreshRegexSnapshotsForAgent',
                    'refreshList',
                    'updateCompanionButtonVisibility',
                ]) {
                    expect(services[name]).not.toHaveBeenCalled();
                }
            },
        );

        test(
            'successful save adopts the returned normalized object, clears draft, refreshes, and stays open',
            async () => {
                const {
                    controller,
                    services,
                    module,
                    events,
                } = await mount();
                controller.update('name', '  Edited  ');
                controller.flushDraft();
                services.saveAgent.mockImplementation(async candidate => {
                    events.push('save');
                    return {
                        ...structuredClone(candidate),
                        name: 'Edited',
                        version: 9,
                    };
                });
                expect(await controller.save()).toBe(true);
                expect(services.saveAgent).toHaveBeenCalledWith(expect.objectContaining({
                    name: 'Edited',
                    id: 'qa-agent',
                    enabled: true,
                }));
                expect(controller.getState().fields).toMatchObject({
                    name: 'Edited',
                    version: 9,
                });
                expect(controller.isDirty()).toBe(false);
                expect(controller.isOpen()).toBe(true);
                expect(localStorage.getItem(module.agentEditorDraftKey('qa-user', 'agent:qa-agent'))).toBeNull();
                expect(events).toEqual(['save', 'regex', 'list', 'buttons']);
                expect(services.refreshRegexSnapshotsForAgent).toHaveBeenCalledWith('qa-agent');
                expect(services.refreshList).toHaveBeenCalledWith(expect.objectContaining({
                    id: 'qa-agent',
                    version: 9,
                }), 'agent:qa-agent');
            },
        );

        test.each([0, 2])(
            'companion save syncs the normalized returned config; history count=%s',
            async count => {
                const {
                    controller,
                    services,
                    events,
                } = await mount({ agent: agentFixture({ execution: 'companion' }) });
                controller.update('companion.includeInChatHistory', true);
                services.saveAgent.mockImplementation(async candidate => {
                    events.push('save');
                    return {
                        ...structuredClone(candidate),
                        companion: {
                            ...candidate.companion,
                            contextMessages: 333,
                        },
                    };
                });
                services.syncCompanionChatHistoryConfig.mockImplementation(async () => {
                    events.push('history');
                    return count;
                });
                expect(await controller.save()).toBe(true);
                expect(services.syncCompanionChatHistoryConfig).toHaveBeenCalledWith(expect.objectContaining({
                    companion: expect.objectContaining({ contextMessages: 333 }),
                }));
                expect(services.saveChatDebounced.mock.calls).toEqual(count > 0 ? [[{ deferBackup: false }]] : []);
                expect(events).toEqual(
                    count > 0 ? ['save', 'history', 'chat', 'regex', 'list', 'buttons']
                        : ['save', 'history', 'regex', 'list', 'buttons'],
                );
            },
        );

        test(
            'failed persistence leaves the draft dirty, publishes nothing and blocks leave',
            async () => {
                jest.spyOn(console, 'error').mockImplementation(() => {});
                const {
                    controller,
                    services,
                    module,
                } = await mount();
                controller.update('name', 'Unsaved');
                controller.flushDraft();
                services.saveAgent.mockRejectedValue(new Error('Failed to save agent'));
                expect(await controller.save()).toBe(false);
                expect(controller.isDirty()).toBe(true);
                expect(controller.isOpen()).toBe(true);
                expect(controller.getState().fields.name).toBe('Unsaved');
                expect(localStorage.getItem(module.agentEditorDraftKey('qa-user', 'agent:qa-agent'))).not.toBeNull();
                expect(services.refreshList).not.toHaveBeenCalled();
                expect(services.refreshRegexSnapshotsForAgent).not.toHaveBeenCalled();
                popupShow.mockResolvedValue(1);
                const proceed = jest.fn();
                expect(await controller.requestLeave({
                    reason: 'drawer-close',
                    proceed,
                })).toBe(false);
                expect(proceed).not.toHaveBeenCalled();
            },
        );

        test.each(['inline', 'companion'])(
            'ordinary %s creation uses explicit create mode, saves an unchanged prefill once and adopts returned identity',
            async execution => {
                const agent = agentFixture({
                    id: 'generated-before-save',
                    enabled: false,
                    execution,
                });
                const {
                    controller,
                    services,
                    module,
                } = await mount({
                    mode: 'create',
                    agent,
                });
                expect(controller.getState()).toMatchObject({
                    key: 'new-agent',
                    mode: 'create',
                    dirty: false,
                });
                expect(services.saveAgent).not.toHaveBeenCalled();
                expect(services.materialise).not.toHaveBeenCalled();
                services.saveAgent.mockImplementation(async candidate => ({
                    ...structuredClone(candidate),
                    id: 'created-agent',
                }));
                expect(await controller.save()).toBe(true);
                expect(services.saveAgent).toHaveBeenCalledTimes(1);
                expect(services.saveAgent).toHaveBeenCalledWith(expect.objectContaining({
                    id: 'generated-before-save',
                    execution,
                    enabled: false,
                }));
                expect(services.materialise).not.toHaveBeenCalled();
                expect(controller.getState()).toMatchObject({
                    key: 'agent:created-agent',
                    mode: 'edit',
                    fields: { id: 'created-agent' },
                    dirty: false,
                    open: true,
                });
                expect(services.refreshList).toHaveBeenCalledWith(expect.objectContaining({ id: 'created-agent' }), 'new-agent');
                expect(await controller.save()).toBe(true);
                expect(services.saveAgent).toHaveBeenCalledTimes(1);
                controller.update('name', 'Edited after creation');
                controller.flushDraft();
                expect(localStorage.getItem(module.agentEditorDraftKey('qa-user', 'new-agent'))).toBeNull();
                expect(localStorage.getItem(module.agentEditorDraftKey('qa-user', 'agent:created-agent'))).not.toBeNull();
                expect(await controller.save()).toBe(true);
                expect(services.saveAgent).toHaveBeenCalledTimes(2);
                expect(services.saveAgent).toHaveBeenLastCalledWith(expect.objectContaining({
                    id: 'created-agent',
                    name: 'Edited after creation',
                }));
            },
        );

        test(
            'ordinary creation recovers the stable new-agent draft despite regenerated prefill IDs',
            async () => {
                const first = await mount({
                    mode: 'create',
                    agent: agentFixture({
                        id: 'generated-first',
                        enabled: false,
                    }),
                });
                first.controller.update('prompt', 'Unfinished creation');
                first.controller.flushDraft();
                first.controller.destroy({ keepDraft: true });
                const reopened = await mount({
                    mode: 'create',
                    agent: agentFixture({
                        id: 'generated-second',
                        enabled: false,
                    }),
                });
                expect(reopened.recovery).toHaveLength(1);
                expect(reopened.controller.getState()).toMatchObject({
                    key: 'new-agent',
                    mode: 'create',
                    dirty: false,
                });
                reopened.recovery[0].actions.restore();
                expect(reopened.controller.getState()).toMatchObject({
                    fields: { prompt: 'Unfinished creation' },
                    dirty: true,
                });
                expect(reopened.services.saveAgent).not.toHaveBeenCalled();
                expect(await reopened.controller.save()).toBe(true);
                expect(localStorage.getItem(reopened.module.agentEditorDraftKey('qa-user', 'new-agent'))).toBeNull();
                expect(reopened.controller.getState()).toMatchObject({
                    mode: 'edit',
                    dirty: false,
                    open: true,
                });
            },
        );

        test(
            'unused catalogue Save materialises once, adopts saved identity, then uses saveAgent',
            async () => {
                const agent = agentFixture({
                    id: 'tpl-qa',
                    sourceTemplateId: 'tpl-qa',
                    enabled: false,
                });
                const {
                    controller,
                    services,
                    module,
                } = await mount({
                    agent,
                    template: { id: 'tpl-qa' },
                    materialiseTemplateId: 'tpl-qa',
                });
                expect(controller.getState().key).toBe('agent-template:tpl-qa');
                expect(services.materialise).not.toHaveBeenCalled();
                controller.update('name', 'Edited catalogue');
                controller.flushDraft();
                const oldDraftKey = module.agentEditorDraftKey('qa-user', 'agent-template:tpl-qa');
                expect(localStorage.getItem(oldDraftKey)).not.toBeNull();
                expect(await controller.save()).toBe(true);
                expect(services.materialise).toHaveBeenCalledTimes(1);
                expect(services.materialise).toHaveBeenCalledWith(
                    'tpl-qa',
                    {
                        edits: expect.objectContaining({
                            name: 'Edited catalogue',
                            phaseLocked: true,
                            enabled: false,
                        }),
                    },
                );
                expect(services.saveAgent).not.toHaveBeenCalled();
                expect(controller.getState()).toMatchObject({
                    key: 'agent:saved-catalogue',
                    fields: {
                        id: 'saved-catalogue',
                        sourceTemplateId: 'tpl-qa',
                    },
                    dirty: false,
                });
                expect(localStorage.getItem(oldDraftKey)).toBeNull();
                expect(services.refreshList).toHaveBeenCalledWith(
                    expect.objectContaining({ id: 'saved-catalogue' }),
                    'agent-template:tpl-qa',
                );
                controller.update('name', 'Second edit');
                expect(await controller.save()).toBe(true);
                expect(services.materialise).toHaveBeenCalledTimes(1);
                expect(services.saveAgent).toHaveBeenCalledWith(expect.objectContaining({
                    id: 'saved-catalogue',
                    name: 'Second edit',
                }));
            },
        );

        test(
            'explicit Save can materialise an unchanged valid catalogue prefill, but opening cannot',
            async () => {
                const {
                    controller,
                    services,
                } = await mount({
                    agent: agentFixture({
                        id: 'tpl-qa',
                        sourceTemplateId: 'tpl-qa',
                        enabled: false,
                    }),
                    materialiseTemplateId: 'tpl-qa',
                });
                expect(controller.isDirty()).toBe(false);
                expect(services.materialise).not.toHaveBeenCalled();
                expect(await controller.save()).toBe(true);
                expect(services.materialise).toHaveBeenCalledTimes(1);
                expect(controller.isOpen()).toBe(true);
            },
        );

        test(
            'failed materialisation retains template identity and recovery draft',
            async () => {
                jest.spyOn(console, 'error').mockImplementation(() => {});
                const {
                    controller,
                    services,
                    module,
                } = await mount({
                    agent: agentFixture({
                        id: 'tpl-qa',
                        sourceTemplateId: 'tpl-qa',
                    }),
                    materialiseTemplateId: 'tpl-qa',
                });
                controller.update('name', 'Unsaved catalogue');
                controller.flushDraft();
                services.materialise.mockRejectedValue(new Error('Failed to save agent'));
                expect(await controller.save()).toBe(false);
                expect(controller.getState().key).toBe('agent-template:tpl-qa');
                expect(controller.isDirty()).toBe(true);
                expect(services.refreshList).not.toHaveBeenCalled();
                expect(localStorage.getItem(module.agentEditorDraftKey('qa-user', 'agent-template:tpl-qa'))).not.toBeNull();
            },
        );

        test(
            'coalesces concurrent Save and leaves edits made during the request dirty',
            async () => {
                const {
                    controller,
                    services,
                } = await mount();
                const pending = deferred();
                services.saveAgent.mockImplementation(candidate => pending.promise.then(() => structuredClone(candidate)));
                controller.update('name', 'Submitted');
                const first = controller.save();
                const second = controller.save();
                await settle();
                expect(services.saveAgent).toHaveBeenCalledTimes(1);
                expect(controller.getState().saving).toBe(true);
                controller.update('name', 'Typed while saving');
                pending.resolve();
                expect(await first).toBe(false);
                expect(await second).toBe(false);
                expect(controller.getState().fields.name).toBe('Typed while saving');
                expect(controller.isDirty()).toBe(true);
                controller.discard();
                expect(controller.getState().fields.name).toBe('Submitted');
                expect(controller.isDirty()).toBe(false);
            },
        );

        test(
            'completion after destroy cannot refresh or overwrite another detail',
            async () => {
                const {
                    controller,
                    services,
                } = await mount();
                const pending = deferred();
                services.saveAgent.mockImplementation(candidate => pending.promise.then(() => structuredClone(candidate)));
                controller.update('name', 'Submitted');
                const saving = controller.save();
                await settle();
                controller.destroy({ keepDraft: true });
                const next = await mount({ agent: agentFixture({ id: 'other-agent' }) });
                next.controller.update('name', 'Other detail draft');
                pending.resolve();
                await saving;
                expect(controller.isOpen()).toBe(false);
                expect(services.refreshList).not.toHaveBeenCalled();
                expect(next.controller.getState().fields.name).toBe('Other detail draft');
                expect(next.controller.isDirty()).toBe(true);
            },
        );
    },
);

describe(
    'Agents editor shared drafts and leave guard',
    () => {
        test(
            'timer backup and recovery Restore preserve hidden fields and local tracker notes without saving',
            async () => {
                const first = await mount();
                first.controller.update('postProcess.appendText', 'Hidden draft');
                first.controller.update('trackerBuilder.rules', 'Transient helper notes');
                await jest.advanceTimersByTimeAsync(5000);
                const key = first.module.agentEditorDraftKey('qa-user', 'agent:qa-agent');
                expect(JSON.parse(localStorage.getItem(key))).toMatchObject({
                    v: 1,
                    snapshot: {
                        fields: { postProcess: { appendText: 'Hidden draft' } },
                        trackerBuilder: { rules: 'Transient helper notes' },
                    },
                });
                first.controller.destroy({ keepDraft: true });
                const reopened = await mount();
                expect(reopened.recovery).toHaveLength(1);
                expect(reopened.controller.isDirty()).toBe(false);
                reopened.recovery[0].actions.restore();
                expect(reopened.controller.getState()).toMatchObject({
                    fields: { postProcess: { appendText: 'Hidden draft' } },
                    trackerBuilder: { rules: 'Transient helper notes' },
                });
                expect(reopened.controller.isDirty()).toBe(true);
                expect(reopened.services.saveAgent).not.toHaveBeenCalled();
            },
        );

        test(
            'recovery Discard and explicit Discard clear only this draft and keep the page open',
            async () => {
                const first = await mount();
                first.controller.update('name', 'Recovery draft');
                first.controller.flushDraft();
                first.controller.destroy({ keepDraft: true });
                const reopened = await mount();
                const otherKey = reopened.module.agentEditorDraftKey('other-user', 'agent:qa-agent');
                localStorage.setItem(otherKey, 'other user data');
                reopened.recovery[0].actions.discard();
                expect(localStorage.getItem(reopened.module.agentEditorDraftKey('qa-user', 'agent:qa-agent'))).toBeNull();
                reopened.controller.update('name', 'Another edit');
                reopened.controller.flushDraft();
                reopened.controller.discard();
                expect(reopened.controller.getState().fields.name).toBe('QA Agent');
                expect(reopened.controller.isDirty()).toBe(false);
                expect(reopened.controller.isOpen()).toBe(true);
                expect(localStorage.getItem(otherKey)).toBe('other user data');
            },
        );

        test(
            'stale recovery callback does not resurrect a closed session',
            async () => {
                const first = await mount();
                first.controller.update('name', 'Recovery draft');
                first.controller.flushDraft();
                first.controller.destroy({ keepDraft: true });
                const reopened = await mount();
                const actions = reopened.recovery[0].actions;
                reopened.controller.destroy({ keepDraft: true });
                expect(() => actions.restore()).not.toThrow();
                expect(reopened.controller.isOpen()).toBe(false);
            },
        );

        test.each(['row-change', 'tab-change', 'drawer-close', 'origin-back'])(
            '%s Cancel blocks the transition using the shared leave guard',
            async reason => {
                const {
                    controller,
                    services,
                } = await mount();
                controller.update('name', 'Unsaved');
                const proceed = jest.fn();
                popupShow.mockResolvedValue(0);
                expect(await controller.requestLeave({
                    reason,
                    proceed,
                })).toBe(false);
                expect(services.confirmLeave).toHaveBeenCalledWith(expect.objectContaining({ session: controller }), reason);
                expect(popupShow).toHaveBeenCalledTimes(1);
                expect(proceed).not.toHaveBeenCalled();
                expect(controller.isDirty()).toBe(true);
                expect(services.saveAgent).not.toHaveBeenCalled();
            },
        );

        test.each(['row-change', 'tab-change', 'drawer-close', 'origin-back'])(
            '%s Discard reverts before allowing the transition',
            async reason => {
                const {
                    controller,
                    services,
                } = await mount();
                controller.update('name', 'Unsaved');
                const proceed = jest.fn(() => expect(controller.isDirty()).toBe(false));
                popupShow.mockResolvedValue(2);
                expect(await controller.requestLeave({
                    reason,
                    proceed,
                })).toBe(true);
                expect(proceed).toHaveBeenCalledTimes(1);
                expect(controller.getState().fields.name).toBe('QA Agent');
                expect(services.saveAgent).not.toHaveBeenCalled();
            },
        );

        test.each(['row-change', 'tab-change', 'drawer-close', 'origin-back'])(
            '%s Save waits for successful persistence before proceeding',
            async reason => {
                const {
                    controller,
                    services,
                } = await mount();
                const pending = deferred();
                services.saveAgent.mockImplementation(candidate => pending.promise.then(() => structuredClone(candidate)));
                controller.update('name', 'Unsaved');
                const proceed = jest.fn();
                popupShow.mockResolvedValue(1);
                const leaving = controller.requestLeave({
                    reason,
                    proceed,
                });
                await settle();
                expect(proceed).not.toHaveBeenCalled();
                expect(services.saveAgent).toHaveBeenCalledTimes(1);
                pending.resolve();
                expect(await leaving).toBe(true);
                expect(proceed).toHaveBeenCalledTimes(1);
                expect(controller.isDirty()).toBe(false);
            },
        );

        test(
            'Save in the leave guard cannot bypass inline prompt validation',
            async () => {
                const {
                    controller,
                    services,
                } = await mount({ agent: agentFixture({ execution: 'companion' }) });
                controller.update('prompt', ' ');
                const proceed = jest.fn();
                popupShow.mockResolvedValue(1);
                expect(await controller.requestLeave({
                    reason: 'origin-back',
                    proceed,
                })).toBe(false);
                expect(proceed).not.toHaveBeenCalled();
                expect(services.saveAgent).not.toHaveBeenCalled();
                expect(controller.isOpen()).toBe(true);
            },
        );

        test.each(['ctrlKey', 'metaKey'])(
            '%s+s uses the real shared keyboard registration',
            async modifier => {
                const {
                    controller,
                    services,
                } = await mount();
                const { registerEditorNavigation } = await import('../../public/scripts/sillybunny-editor/navigation.js');
                unregisters.add(registerEditorNavigation({
                    session: controller,
                    isActive: () => true,
                    close: jest.fn(),
                    escape: false,
                }));
                controller.update('name', 'Keyboard save');
                const event = new KeyboardEvent('keydown', {
                    key: 's',
                    [modifier]: true,
                    bubbles: true,
                    cancelable: true,
                });
                document.dispatchEvent(event);
                await settle();
                expect(event.defaultPrevented).toBe(true);
                expect(services.saveAgent).toHaveBeenCalledTimes(1);
                expect(controller.isDirty()).toBe(false);
                expect(controller.isOpen()).toBe(true);
            },
        );
    },
);
