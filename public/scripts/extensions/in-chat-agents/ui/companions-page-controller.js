import { isSuppressedCompanionResult, isValidCompanionMessage } from '../companion/companion-shared.js';

const tokenCount = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0;

export function buildCompanionsPageModel({ agents, chat, enabled, conversationMode }, selectors) {
    if (conversationMode) return { status: 'conversation-mode', sections: [], actions: [], runAllDisabled: true, notice: null };
    const latest = new Map();
    const notes = [];
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (!isValidCompanionMessage(message)) continue;
        for (const [agentId, result] of Object.entries(selectors.getResults(message))) {
            if (!result || typeof result !== 'object' || isSuppressedCompanionResult(agentId, result)) continue;
            if (!latest.has(agentId)) latest.set(agentId, result);
            if (result.status !== 'done' || notes.length >= 20) continue;
            const content = selectors.resolveContent(String(result.content ?? ''), message).replace(/\s+/g, ' ').trim();
            notes.push({
                key: `note:${index}:${agentId}`, messageIndex: index, agentId,
                agentName: String(result.agentName ?? '').trim() || selectors.getAgentById(agentId)?.name || 'Companion',
                snippet: content.length > 120 ? `${content.slice(0, 120)}…` : content,
            });
        }
    }
    const companions = agents.filter(agent => !selectors.isToolAgent(agent) && selectors.isCompanionAgent(agent)).map(agent => ({
        id: agent.id, name: agent.name || 'Untitled Companion',
        enabled: selectors.isAgentEnabledForCurrentScope(agent),
        config: structuredClone(selectors.getCompanionConfig(agent)),
        tokenUsage: {
            inputTokens: tokenCount(latest.get(agent.id)?.tokenUsage?.inputTokens),
            outputTokens: tokenCount(latest.get(agent.id)?.tokenUsage?.outputTokens),
        },
    }));
    return {
        status: 'ready', notice: enabled ? null : 'globally-disabled',
        actions: ['run-all', 'open-panel'], runAllDisabled: !enabled,
        sections: [{ id: 'companions', rows: companions }, { id: 'notes', rows: notes }],
    };
}

export function createCompanionsPageController({ services, onChange }) {
    let destroyed = false;
    let running = false;
    let timer;
    let unsubscribe;
    let state;
    const publish = () => {
        state = buildCompanionsPageModel(services.readSnapshot(), services.selectors);
        state.runAllDisabled ||= running;
        onChange?.(state);
    };
    const refresh = () => {
        if (destroyed) return;
        const unavailable = services.readSnapshot().conversationMode;
        if (unavailable) {
            clearTimeout(timer);
            unsubscribe?.();
            unsubscribe = null;
        } else if (!unsubscribe) {
            unsubscribe = services.subscribeResults(() => {
                clearTimeout(timer);
                timer = setTimeout(refresh, 100);
            });
        }
        publish();
    };
    refresh();
    const available = () => !destroyed && !services.readSnapshot().conversationMode;
    return {
        getState: () => state, refresh,
        async runAll() {
            if (!available() || running || !services.readSnapshot().enabled) return false;
            const index = services.getLatestMessageIndex();
            if (index < 0) {
                services.notify('no-message');
                return false;
            }
            running = true;
            publish();
            try {
                const results = await services.runAll(index);
                if (available() && !Object.keys(results ?? {}).length) services.notify('no-companions-ran');
                return results;
            } finally {
                running = false;
                refresh();
            }
        },
        edit(id) { if (available()) return services.openEditor(id); },
        openPanel() { if (available()) return services.openPanel(); },
        jump(index) { if (available() && Number.isInteger(index)) return services.jumpToMessage(index); },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            clearTimeout(timer);
            unsubscribe?.();
            unsubscribe = null;
        },
    };
}
