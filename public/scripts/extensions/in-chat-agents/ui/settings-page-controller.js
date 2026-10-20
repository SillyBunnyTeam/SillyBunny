const groups = [
    ['connections', [
        ['connectionProfile', 'connectionProfile', '', 'profile'],
        ['companionConnectionProfile', 'companionConnectionProfile', '', 'profile'],
    ]],
    ['running-agents', [
        ['appendAgentsExecutionMode', 'appendAgentsExecutionMode', 'parallel', 'toggle'],
        ['companionExecutionMode', 'companionExecutionMode', 'parallel', 'toggle'],
        ['companionConcurrent', 'companionConcurrentWithPostGen', false, 'switch'],
    ]],
    ['chats', [['separateRecentChats', 'separateRecentChats', false, 'switch']]],
    ['notifications-and-display', [
        ['promptTransformShowNotifications', 'promptTransformShowNotifications', true, 'switch'],
        ['postMainInterceptShowMessageFirst', 'postMainInterceptShowMessageFirst', true, 'switch'],
    ]],
    ['advanced', [
        ['helperPrefillMessages', 'helperPrefillMessages', '', 'textarea'],
        ['pathfinderSubmoduleEnabled', 'pathfinderEnabled', true, 'switch'],
    ]],
];

export function buildSettingsPageModel(settings = {}) {
    return { groups: groups.map(([id, fields]) => ({
        id,
        rows: fields.map(([name, key, defaultValue, kind]) => ({
            id: `ica--${name}`, key, defaultValue, kind,
            event: kind === 'textarea' ? 'input' : 'change',
            value: settings[key] ?? defaultValue,
        })),
    })) };
}

export function createSettingsPageController({ services, onChange }) {
    let destroyed = false;
    let state = buildSettingsPageModel(services.readSettings());
    const refresh = () => {
        if (destroyed) return;
        state = buildSettingsPageModel(services.readSettings());
        onChange?.(state);
    };
    return {
        getState: () => state,
        refresh,
        async change(controlId, value, eventType = 'change') {
            if (destroyed) return;
            const field = state.groups.flatMap(group => group.rows).find(row => row.id === controlId);
            if (!field) throw new Error(`Unknown setting: ${controlId}`);
            if (field.event !== eventType) return;
            await services.applySetting(field.key, value);
            refresh();
        },
        async reset() {
            if (destroyed) return;
            const result = await services.resetBundledAgents();
            refresh();
            return result;
        },
        destroy() { destroyed = true; },
    };
}
