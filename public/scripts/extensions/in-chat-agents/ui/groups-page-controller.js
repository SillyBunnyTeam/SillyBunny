const groupKey = group => `group:${group.builtin ? 'builtin' : 'custom'}:${group.id}`;

export function buildGroupsPageModel(groups) {
    return { sections: ['builtin', 'custom'].map(id => ({
        id,
        rows: groups.filter(group => Boolean(group.builtin) === (id === 'builtin')).map(group => ({
            key: groupKey(group), id: group.id, name: group.name, description: group.description,
            memberCount: (group.agentTemplateIds?.length ?? 0) + (group.customAgents?.length ?? 0),
            canDelete: !group.builtin, menu: group.builtin ? [] : ['delete'],
        })),
    })) };
}

export function createGroupsPageController({ services, onChange }) {
    let destroyed = false;
    const pending = new Set();
    let state = buildGroupsPageModel(services.getGroups());
    const refresh = () => {
        if (destroyed) return;
        state = buildGroupsPageModel(services.getGroups());
        for (const row of state.sections.flatMap(section => section.rows)) row.pending = pending.has(row.key);
        onChange?.(state);
    };
    const resolve = key => destroyed || pending.has(key) ? null : services.getGroups().find(group => groupKey(group) === key);
    return {
        getState: () => state, refresh,
        async turnOn(key) {
            const group = resolve(key);
            if (!group) return false;
            pending.add(key);
            refresh();
            try {
                const result = await services.turnOnGroup(group);
                if (!destroyed) services.notifyTurnOn(result, group);
                return result;
            } finally {
                pending.delete(key);
                refresh();
            }
        },
        async delete(key) {
            const group = resolve(key);
            if (!group || group.builtin) return false;
            pending.add(key);
            refresh();
            try {
                if (!await services.confirmDelete(group) || destroyed) return false;
                await services.deleteGroup(group.id);
                return true;
            } finally {
                pending.delete(key);
                refresh();
            }
        },
        async create() {
            if (destroyed) return;
            await services.createGroup();
            refresh();
        },
        destroy() { destroyed = true; },
    };
}
