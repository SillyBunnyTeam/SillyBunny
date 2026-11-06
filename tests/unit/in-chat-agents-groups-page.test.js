/* global globalThis */
/* eslint-disable playwright/no-standalone-expect -- Jest DOM-free page contracts use the real catalogue/store without a browser. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const loadPage = () => import('../../public/scripts/extensions/in-chat-agents/ui/groups-page-controller.js');
const originalFetch = globalThis.fetch;
const mounted = new Set();

function group(id, overrides = {}) {
    return { id, name: id, description: '', builtin: false, agentTemplateIds: [], customAgents: [], ...overrides };
}

function rows(model, section) {
    return model.sections.find(item => item.id === section).rows;
}

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

async function mount(groups = [group('custom')], overrides = {}, page) {
    const module = page ?? await loadPage();
    const services = {
        getGroups: jest.fn(() => groups),
        turnOnGroup: jest.fn(async () => ({ added: 0, enabled: 1, agentIds: ['member'] })),
        deleteGroup: jest.fn(async id => {
            const index = groups.findIndex(item => item.id === id && !item.builtin);
            if (index >= 0) groups.splice(index, 1);
        }),
        createGroup: jest.fn(async () => {}),
        confirmDelete: jest.fn(async () => true),
        notifyTurnOn: jest.fn(),
        ...overrides,
    };
    const onChange = jest.fn();
    const controller = module.createGroupsPageController({ services, onChange });
    mounted.add(controller);
    return { controller, services, onChange };
}

async function realDependencies() {
    // Import the absent A4 seam before any existing collaborator can fail this red contract.
    const page = await loadPage();
    const chatContext = { groupId: null };
    const extensionSettings = { inChatAgents: { autoSeededTemplateIds: ['keep-seed'] } };
    let nextId = 0;
    await jest.unstable_mockModule('../../public/script.js', () => ({
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced: jest.fn(),
    }));
    await jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
        extension_settings: extensionSettings,
        getContext: () => chatContext,
    }));
    await jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
        uuidv4: () => `groups-page-uuid-${++nextId}`,
        regexFromString: value => new RegExp(String(value ?? '')),
    }));
    globalThis.fetch = jest.fn(async () => ({ ok: true }));
    const store = await import('../../public/scripts/extensions/in-chat-agents/agent-store.js');
    const catalogue = await import('../../public/scripts/extensions/in-chat-agents/catalogue.js');
    const context = {
        templates: [
            { id: 'tpl-one', name: 'First bundle', prompt: 'Factory prompt', category: 'content', execution: 'inline' },
            { id: 'tpl-two', name: 'Second bundle', prompt: 'Second prompt', category: 'content', execution: 'inline' },
        ],
        regexBundles: {},
        getAgents: store.getAgents,
        saveAgent: jest.fn(store.saveAgent),
        initializeScopedAgentEnableState: store.initializeScopedAgentEnableState,
        setAgentEnabledForCurrentScope: store.setAgentEnabledForCurrentScope,
        persistState: jest.fn(store.persistAgentGlobalSettings),
        autoSeededTemplateIds: new Set(['keep-seed']),
    };
    const mountReal = overrides => mount([], {
        getGroups: jest.fn(store.getGroups),
        turnOnGroup: jest.fn(item => catalogue.turnOnGroup(item, context)),
        deleteGroup: jest.fn(store.deleteGroup),
        ...overrides,
    }, page);
    return { store, context, chatContext, extensionSettings, mountReal };
}

beforeEach(() => jest.resetModules());
afterEach(() => {
    for (const controller of mounted) controller.destroy();
    mounted.clear();
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
});

describe('A4 Agent Groups page model', () => {
    test('exports DOM-free group model and controller seams', async () => {
        const module = await loadPage();
        expect(typeof module.buildGroupsPageModel).toBe('function');
        expect(typeof module.createGroupsPageController).toBe('function');
    });

    test('keeps built-in then custom sections, preserving source order within each', async () => {
        const module = await loadPage();
        const model = module.buildGroupsPageModel([
            group('z-custom'), group('z-builtin', { builtin: true }),
            group('a-custom'), group('a-builtin', { builtin: true }),
        ]);
        expect(model.sections.map(section => section.id)).toEqual(['builtin', 'custom']);
        expect(rows(model, 'builtin').map(row => row.id)).toEqual(['z-builtin', 'a-builtin']);
        expect(rows(model, 'custom').map(row => row.id)).toEqual(['z-custom', 'a-custom']);
    });

    test('empty data retains both empty sections instead of creating a catalogue or agent list', async () => {
        const module = await loadPage();
        expect(module.buildGroupsPageModel([]).sections).toEqual([
            { id: 'builtin', rows: [] }, { id: 'custom', rows: [] },
        ]);
    });

    test('namespaces identical IDs by built-in/custom origin and exposes Delete only in custom row menus', async () => {
        const module = await loadPage();
        const model = module.buildGroupsPageModel([group('same', { builtin: true }), group('same')]);
        expect(rows(model, 'builtin')[0]).toMatchObject({ key: 'group:builtin:same', canDelete: false, menu: [] });
        expect(rows(model, 'custom')[0]).toMatchObject({ key: 'group:custom:same', canDelete: true, menu: ['delete'] });
    });

    test('retains descriptions and counts declared templates plus snapshots, including repeated/missing references', async () => {
        const module = await loadPage();
        const model = module.buildGroupsPageModel([
            group('described', {
                name: 'User group', description: 'Existing user description',
                agentTemplateIds: ['tpl-one', 'tpl-one', 'missing'], customAgents: [{ name: 'Snapshot' }],
            }),
            group('without-description'),
        ]);
        expect(rows(model, 'custom')[0]).toMatchObject({
            name: 'User group', description: 'Existing user description', memberCount: 4,
        });
        expect(rows(model, 'custom')[1]).toMatchObject({ description: '', memberCount: 0 });
    });

    test('building and refreshing are read-only and never materialize agents or persist groups', async () => {
        const module = await loadPage();
        const groups = [group('saved', { customAgents: [{ name: 'Snapshot', settings: { keep: true } }] })];
        const before = structuredClone(groups);
        module.buildGroupsPageModel(groups);
        const { controller, services } = await mount(groups, {}, module);
        controller.getState();
        controller.refresh();
        expect(groups).toEqual(before);
        for (const name of ['turnOnGroup', 'deleteGroup', 'createGroup', 'confirmDelete', 'notifyTurnOn']) {
            expect(services[name]).not.toHaveBeenCalled();
        }
    });
});

describe('A4 Agent Groups page action boundary', () => {
    test('Turn On resolves the exact namespaced row and summarizes the returned result once after success', async () => {
        const pending = deferred();
        const builtin = group('same', { builtin: true });
        const custom = group('same');
        const { controller, services } = await mount([builtin, custom], { turnOnGroup: jest.fn(() => pending.promise) });
        const running = controller.turnOn('group:custom:same');
        expect(services.turnOnGroup).toHaveBeenCalledTimes(1);
        expect(services.turnOnGroup).toHaveBeenCalledWith(custom);
        expect(services.notifyTurnOn).not.toHaveBeenCalled();
        const result = { added: 2, enabled: 3, agentIds: ['a', 'b', 'c'] };
        pending.resolve(result);
        expect(await running).toEqual(result);
        expect(services.notifyTurnOn).toHaveBeenCalledTimes(1);
        expect(services.notifyTurnOn).toHaveBeenCalledWith(result, custom);
    });

    test('a pending row ignores repeated Turn On and Delete without blocking other rows', async () => {
        const pending = deferred();
        const { controller, services } = await mount([group('one'), group('two')], {
            turnOnGroup: jest.fn(item => item.id === 'one' ? pending.promise : Promise.resolve({ added: 0, enabled: 0, agentIds: [] })),
        });
        const first = controller.turnOn('group:custom:one');
        await controller.turnOn('group:custom:one');
        await controller.delete('group:custom:one');
        await controller.turnOn('group:custom:two');
        expect(services.turnOnGroup).toHaveBeenCalledTimes(2);
        expect(services.confirmDelete).not.toHaveBeenCalled();
        expect(services.deleteGroup).not.toHaveBeenCalled();
        pending.resolve({ added: 0, enabled: 1, agentIds: ['one'] });
        await first;
    });

    test('a failed Turn On propagates the error without a success summary and releases the pending guard', async () => {
        const error = new Error('agent save failed');
        const { controller, services } = await mount(undefined, {
            turnOnGroup: jest.fn().mockRejectedValueOnce(error).mockResolvedValue({ added: 0, enabled: 1, agentIds: ['member'] }),
        });
        await expect(controller.turnOn('group:custom:custom')).rejects.toThrow(error);
        expect(services.notifyTurnOn).not.toHaveBeenCalled();
        await controller.turnOn('group:custom:custom');
        expect(services.turnOnGroup).toHaveBeenCalledTimes(2);
        expect(services.notifyTurnOn).toHaveBeenCalledTimes(1);
    });

    test('built-in Delete is rejected even when invoked directly, before confirmation or persistence', async () => {
        const { controller, services } = await mount([group('builtin', { builtin: true })]);
        await controller.delete('group:builtin:builtin');
        expect(services.confirmDelete).not.toHaveBeenCalled();
        expect(services.deleteGroup).not.toHaveBeenCalled();
    });

    test('cancelled custom Delete leaves the row and never calls the backend boundary', async () => {
        const custom = group('custom');
        const { controller, services } = await mount([custom], { confirmDelete: jest.fn(async () => false) });
        await controller.delete('group:custom:custom');
        expect(services.confirmDelete).toHaveBeenCalledWith(custom);
        expect(services.deleteGroup).not.toHaveBeenCalled();
        expect(rows(controller.getState(), 'custom').map(row => row.id)).toEqual(['custom']);
    });

    test('confirmation owns the per-row guard until accepted deletion finishes', async () => {
        const confirmation = deferred();
        const deletion = deferred();
        const { controller, services } = await mount(undefined, {
            confirmDelete: jest.fn(() => confirmation.promise), deleteGroup: jest.fn(() => deletion.promise),
        });
        const first = controller.delete('group:custom:custom');
        await controller.delete('group:custom:custom');
        await controller.turnOn('group:custom:custom');
        expect(services.confirmDelete).toHaveBeenCalledTimes(1);
        expect(services.turnOnGroup).not.toHaveBeenCalled();
        confirmation.resolve(true);
        await Promise.resolve();
        expect(services.deleteGroup).toHaveBeenCalledTimes(1);
        expect(services.deleteGroup).toHaveBeenCalledWith('custom');
        await controller.delete('group:custom:custom');
        expect(services.confirmDelete).toHaveBeenCalledTimes(1);
        deletion.resolve();
        await first;
    });

    test('Save Agents as Group delegates the existing dialog and refreshes only after it completes', async () => {
        const pending = deferred();
        const groups = [];
        const { controller, services } = await mount(groups, { createGroup: jest.fn(() => pending.promise) });
        const creating = controller.create();
        expect(services.createGroup).toHaveBeenCalledTimes(1);
        expect(services.createGroup).toHaveBeenCalledWith();
        expect(rows(controller.getState(), 'custom')).toEqual([]);
        groups.push(group('created'));
        pending.resolve();
        await creating;
        expect(rows(controller.getState(), 'custom').map(row => row.id)).toEqual(['created']);
        expect(services.turnOnGroup).not.toHaveBeenCalled();
    });

    test('destroy is idempotent and prevents late action invocations and view notifications', async () => {
        const { controller, services, onChange } = await mount();
        controller.destroy();
        controller.destroy();
        const count = onChange.mock.calls.length;
        await controller.turnOn('group:custom:custom');
        await controller.delete('group:custom:custom');
        await controller.create();
        controller.refresh();
        expect(onChange).toHaveBeenCalledTimes(count);
        for (const name of ['turnOnGroup', 'deleteGroup', 'createGroup', 'confirmDelete', 'notifyTurnOn']) {
            expect(services[name]).not.toHaveBeenCalled();
        }
    });

    test('destroy during confirmation never starts a delete after the user responds', async () => {
        const pending = deferred();
        const { controller, services, onChange } = await mount(undefined, { confirmDelete: jest.fn(() => pending.promise) });
        const deleting = controller.delete('group:custom:custom');
        controller.destroy();
        const count = onChange.mock.calls.length;
        pending.resolve(true);
        await deleting;
        expect(services.deleteGroup).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledTimes(count);
    });

    test('destroy during Turn On suppresses late success summaries and rerenders without cancelling persistence', async () => {
        const pending = deferred();
        const { controller, services, onChange } = await mount(undefined, { turnOnGroup: jest.fn(() => pending.promise) });
        const running = controller.turnOn('group:custom:custom');
        controller.destroy();
        const count = onChange.mock.calls.length;
        pending.resolve({ added: 0, enabled: 1, agentIds: ['member'] });
        await running;
        expect(services.turnOnGroup).toHaveBeenCalledTimes(1);
        expect(services.notifyTurnOn).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledTimes(count);
    });
});

describe('A4 Agent Groups uses the existing additive catalogue and backend store', () => {
    test('template Turn On preserves edited and unrelated agents, deduplicates members, skips missing IDs and repeats without extra saves', async () => {
        const { store, context, extensionSettings, mountReal } = await realDependencies();
        store.loadAgents([
            { id: 'saved-one', sourceTemplateId: 'tpl-one', name: 'Edited first', prompt: 'Keep my prompt', connectionProfile: 'keep-profile', enabled: false },
            { id: 'unrelated-on', name: 'Unrelated on', enabled: true },
            { id: 'unrelated-off', name: 'Unrelated off', enabled: false },
        ]);
        store.loadBuiltinGroups([group('bundled', { agentTemplateIds: ['tpl-one', 'tpl-two', 'tpl-two', 'missing'] })]);
        const { controller, services } = await mountReal();
        const result = await controller.turnOn('group:builtin:bundled');
        const added = store.getAgents().find(agent => agent.sourceTemplateId === 'tpl-two');
        expect(result).toEqual({ added: 1, enabled: 2, agentIds: ['saved-one', added.id] });
        expect(store.getAgentById('saved-one')).toMatchObject({ enabled: true, prompt: 'Keep my prompt', connectionProfile: 'keep-profile' });
        expect(store.getAgentById('unrelated-on').enabled).toBe(true);
        expect(store.getAgentById('unrelated-off').enabled).toBe(false);
        expect(context.saveAgent).toHaveBeenCalledTimes(2);
        expect(context.persistState).toHaveBeenCalledTimes(2);
        expect(await controller.turnOn('group:builtin:bundled')).toEqual({ added: 0, enabled: 0, agentIds: ['saved-one', added.id] });
        expect(store.getAgents()).toHaveLength(4);
        expect(context.saveAgent).toHaveBeenCalledTimes(2);
        expect(context.persistState).toHaveBeenCalledTimes(2);
        expect(services.notifyTurnOn).toHaveBeenNthCalledWith(1, result, store.getGroups()[0]);
        expect(services.notifyTurnOn).toHaveBeenCalledTimes(2);
        expect(extensionSettings.inChatAgents.autoSeededTemplateIds).toEqual(['keep-seed']);
    });

    test.each(['individual', 'group'])('snapshot Turn On changes only the %s scope, preserving unrelated current-scope members and the other scope', async scope => {
        const { store, context, chatContext, extensionSettings, mountReal } = await realDependencies();
        chatContext.groupId = scope === 'group' ? 'active-group' : null;
        const otherScope = scope === 'group' ? 'individual' : 'group';
        store.loadAgents([
            { id: 'matched', name: 'Custom note', prompt: 'Custom prompt', settings: { keep: true }, enabled: false },
            { id: 'unrelated-on', name: 'Unrelated on', enabled: true },
            { id: 'unrelated-off', name: 'Unrelated off', enabled: false },
            { id: 'other-scope', name: 'Other scope', enabled: true },
        ]);
        store.setGlobalSettings({
            separateRecentChats: true, scopedEnabledAgentIdsInitialized: true,
            enabledAgentIdsByChatType: { [scope]: ['unrelated-on'], [otherScope]: ['other-scope'] },
        });
        store.loadCustomGroups([group('snapshots', { customAgents: [
            { name: ' custom NOTE ', prompt: 'Custom prompt' },
            { id: 'not-a-saved-id', name: 'Fresh custom', prompt: 'Fresh prompt', favorite: true },
        ] })]);
        const { controller, services } = await mountReal();
        const result = await controller.turnOn('group:custom:snapshots');
        const added = store.getAgents().find(agent => agent.name === 'Fresh custom');
        expect(result).toEqual({ added: 1, enabled: 2, agentIds: ['matched', added.id] });
        expect(added.id).not.toBe('not-a-saved-id');
        expect(added.favorite).toBe(true);
        expect(store.getAgentById('matched').settings).toEqual({ keep: true });
        expect(store.getGlobalSettings().enabledAgentIdsByChatType).toEqual({
            [scope]: ['unrelated-on', 'matched', added.id], [otherScope]: ['other-scope'],
        });
        expect(extensionSettings.inChatAgents.globalSettings.enabledAgentIdsByChatType).toEqual({
            [scope]: ['unrelated-on', 'matched', added.id], [otherScope]: ['other-scope'],
        });
        expect(store.isAgentEnabledForCurrentScope(store.getAgentById('unrelated-on'))).toBe(true);
        expect(store.isAgentEnabledForCurrentScope(store.getAgentById('unrelated-off'))).toBe(false);
        expect(context.saveAgent).toHaveBeenCalledTimes(2);
        expect(services.notifyTurnOn).toHaveBeenCalledTimes(1);
    });

    test('legacy custom saved-ID groups enable in place and keep their existing schema', async () => {
        const { store, context, mountReal } = await realDependencies();
        store.loadAgents([{ id: 'legacy-saved', name: 'Legacy custom', prompt: 'Keep legacy prompt', enabled: false }]);
        store.loadCustomGroups([group('legacy', { agentTemplateIds: ['legacy-saved', 'missing'] })]);
        const before = structuredClone(store.getGroups());
        const { controller } = await mountReal();
        expect(await controller.turnOn('group:custom:legacy')).toEqual({ added: 0, enabled: 1, agentIds: ['legacy-saved'] });
        expect(store.getAgents()).toHaveLength(1);
        expect(store.getAgentById('legacy-saved')).toMatchObject({ enabled: true, prompt: 'Keep legacy prompt' });
        expect(store.getGroups()).toEqual(before);
        expect(context.saveAgent).toHaveBeenCalledTimes(1);
    });

    test('confirmed custom Delete delegates once to the existing backend endpoint, refreshes rows and never deletes agents', async () => {
        const { store, mountReal } = await realDependencies();
        store.loadAgents([{ id: 'keep-member', name: 'Keep member', enabled: true }]);
        store.loadBuiltinGroups([group('same')]);
        store.loadCustomGroups([group('same', { agentTemplateIds: ['keep-member'] }), group('keep-group')]);
        const before = structuredClone(store.getAgents());
        const { controller, services } = await mountReal();
        await controller.delete('group:custom:same');
        expect(services.confirmDelete).toHaveBeenCalledTimes(1);
        expect(services.deleteGroup).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledWith('/api/in-chat-agents/groups/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'same' }),
        });
        expect(rows(controller.getState(), 'builtin').map(row => row.id)).toEqual(['same']);
        expect(rows(controller.getState(), 'custom').map(row => row.id)).toEqual(['keep-group']);
        expect(store.getAgents()).toEqual(before);
    });

    test('backend Delete rejection reaches the caller without requiring rollback of the existing optimistic group cache', async () => {
        const { store, mountReal } = await realDependencies();
        store.loadCustomGroups([group('failed-delete')]);
        globalThis.fetch.mockResolvedValueOnce({ ok: false });
        const { controller, services } = await mountReal();
        await expect(controller.delete('group:custom:failed-delete')).rejects.toThrow('Failed to delete group');
        expect(services.confirmDelete).toHaveBeenCalledTimes(1);
        expect(services.deleteGroup).toHaveBeenCalledTimes(1);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
});
