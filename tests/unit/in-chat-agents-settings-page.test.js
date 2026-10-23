/* eslint-disable playwright/no-standalone-expect -- Jest page-controller contracts do not use a browser. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

const loadPage = () => import('../../public/scripts/extensions/in-chat-agents/ui/settings-page-controller.js');
const mounted = new Set();
const fields = [
    ['connectionProfile', 'connectionProfile', '', 'profile', 'connections', 'change', 'profile-main'],
    ['companionConnectionProfile', 'companionConnectionProfile', '', 'profile', 'connections', 'change', 'profile-companion'],
    ['appendAgentsExecutionMode', 'appendAgentsExecutionMode', 'parallel', 'toggle', 'running-agents', 'change', 'sequential'],
    ['companionExecutionMode', 'companionExecutionMode', 'parallel', 'toggle', 'running-agents', 'change', 'sequential'],
    ['companionConcurrent', 'companionConcurrentWithPostGen', false, 'switch', 'running-agents', 'change', true],
    ['separateRecentChats', 'separateRecentChats', false, 'switch', 'chats', 'change', true],
    ['promptTransformShowNotifications', 'promptTransformShowNotifications', true, 'switch', 'notifications-and-display', 'change', false],
    ['postMainInterceptShowMessageFirst', 'postMainInterceptShowMessageFirst', true, 'switch', 'notifications-and-display', 'change', false],
    ['helperPrefillMessages', 'helperPrefillMessages', '', 'textarea', 'advanced', 'input', '  [assistant] Keep spacing\n\n[system] Extra instruction\n'],
    ['pathfinderSubmoduleEnabled', 'pathfinderEnabled', true, 'switch', 'advanced', 'change', false],
];

function rows(model) {
    return model.groups.flatMap(group => group.rows);
}

async function mount(settings = {}, overrides = {}) {
    const module = await loadPage();
    const state = structuredClone(settings);
    const services = {
        readSettings: jest.fn(() => state),
        applySetting: jest.fn((key, value) => {
            state[key] = value;
        }),
        resetBundledAgents: jest.fn(async () => ({ reset: 2, added: 0 })),
        ...overrides,
    };
    const onChange = jest.fn();
    const controller = module.createSettingsPageController({ services, onChange });
    mounted.add(controller);
    return { controller, services, state, onChange };
}

afterEach(() => {
    for (const controller of mounted) controller.destroy();
    mounted.clear();
    jest.restoreAllMocks();
});

describe('A4 Settings page existing data contract', () => {
    test('exports DOM-free model and instant-apply controller seams', async () => {
        const module = await loadPage();
        expect(typeof module.buildSettingsPageModel).toBe('function');
        expect(typeof module.createSettingsPageController).toBe('function');
    });

    test('has five ordered groups and exactly ten setting IDs, with Reset kept out of persisted fields', async () => {
        const module = await loadPage();
        const model = module.buildSettingsPageModel({});
        expect(model.groups.map(group => [group.id, group.rows.length])).toEqual([
            ['connections', 2],
            ['running-agents', 3],
            ['chats', 1],
            ['notifications-and-display', 2],
            ['advanced', 2],
        ]);
        expect(rows(model).map(row => row.id)).toEqual(fields.map(([id]) => `ica--${id}`));
        expect(rows(model).map(row => row.key)).not.toContain('resetDefaults');
        expect(rows(model).map(row => row.key)).not.toContain('enabled');
    });

    test.each(fields)('%s retains its exact key, default, kind, group and commit event', async (id, key, defaultValue, kind, groupId, event) => {
        const module = await loadPage();
        const model = module.buildSettingsPageModel({});
        const group = model.groups.find(group => group.id === groupId);
        expect(group.rows.find(row => row.id === `ica--${id}`)).toMatchObject({
            id: `ica--${id}`, key, defaultValue, value: defaultValue, kind, event,
        });
    });

    test.each(fields)('%s applies immediately once under the original key without a Save operation', async (id, key, _default, _kind, _group, event, value) => {
        const { controller, services, state } = await mount();
        const pending = controller.change(`ica--${id}`, value, event);
        expect(services.applySetting).toHaveBeenCalledTimes(1);
        expect(services.applySetting).toHaveBeenCalledWith(key, value);
        expect(state[key]).toEqual(value);
        await pending;
        expect(rows(controller.getState()).find(row => row.key === key).value).toEqual(value);
        expect(services.resetBundledAgents).not.toHaveBeenCalled();
    });

    test('reading, opening and refreshing never normalize or persist imported opaque state', async () => {
        const imported = {
            enabled: false,
            connectionProfile: 'missing-profile',
            appendAgentsExecutionMode: 'legacy-mode',
            companionExecutionMode: 'sequential',
            helperPrefillMessages: '\n  [assistant] Unchanged\n',
            enabledAgentIdsByChatType: { individual: ['a'], group: ['b'] },
            scopedEnabledAgentIdsInitialized: true,
            unknownFutureKey: { keep: true },
        };
        const { controller, services, state } = await mount(imported);
        controller.getState();
        controller.refresh();
        expect(state).toEqual(imported);
        expect(services.applySetting).not.toHaveBeenCalled();
        expect(services.resetBundledAgents).not.toHaveBeenCalled();
        expect(rows(controller.getState()).find(row => row.key === 'appendAgentsExecutionMode').value).toBe('legacy-mode');
        expect(rows(controller.getState()).find(row => row.key === 'connectionProfile').value).toBe('missing-profile');
    });

    test('helper input retains whitespace and does not commit a second time on change', async () => {
        const { controller, services } = await mount();
        const text = '\n[system]  A\n\n[assistant] B  \n';
        await controller.change('ica--helperPrefillMessages', text, 'input');
        await controller.change('ica--helperPrefillMessages', text, 'change');
        expect(services.applySetting).toHaveBeenCalledTimes(1);
        expect(services.applySetting).toHaveBeenCalledWith('helperPrefillMessages', text);
    });

    test('non-helper input does not bypass the existing change commit boundary', async () => {
        const { controller, services } = await mount();
        await controller.change('ica--companionConcurrent', true, 'input');
        expect(services.applySetting).not.toHaveBeenCalled();
        await controller.change('ica--companionConcurrent', true, 'change');
        expect(services.applySetting).toHaveBeenCalledWith('companionConcurrentWithPostGen', true);
    });

    test('external profile/toggle changes refresh displayed values without replaying handlers', async () => {
        const { controller, services, state } = await mount({ connectionProfile: 'old-profile' });
        state.connectionProfile = 'new-profile';
        state.pathfinderEnabled = false;
        controller.refresh();
        const values = Object.fromEntries(rows(controller.getState()).map(row => [row.key, row.value]));
        expect(values).toMatchObject({ connectionProfile: 'new-profile', pathfinderEnabled: false });
        expect(services.applySetting).not.toHaveBeenCalled();
    });

    test('Reset delegates the existing Q49 guard/confirmation/factory pipeline once, not a settings rewrite', async () => {
        const { controller, services, state } = await mount({
            enabledAgentIdsByChatType: { individual: ['keep-a'], group: ['keep-b'] },
            enabled: false,
            unknown: { keep: true },
        });
        const before = structuredClone(state);
        expect(await controller.reset()).toEqual({ reset: 2, added: 0 });
        expect(services.resetBundledAgents).toHaveBeenCalledTimes(1);
        expect(services.applySetting).not.toHaveBeenCalled();
        expect(state).toEqual(before);
    });

    test('rejects an unknown control before invoking the persistence boundary', async () => {
        const { controller, services } = await mount();
        await expect(async () => controller.change('ica--not-a-setting', true)).rejects.toThrow(/unknown.*setting|setting.*unknown/i);
        expect(services.applySetting).not.toHaveBeenCalled();
    });

    test('destroy is idempotent and late changes/reset/refresh cannot invoke services or notify the view', async () => {
        const { controller, services, onChange } = await mount();
        controller.destroy();
        controller.destroy();
        const count = onChange.mock.calls.length;
        await controller.change('ica--connectionProfile', 'late-profile');
        await controller.reset();
        controller.refresh();
        expect(services.applySetting).not.toHaveBeenCalled();
        expect(services.resetBundledAgents).not.toHaveBeenCalled();
        expect(onChange).toHaveBeenCalledTimes(count);
    });
});
