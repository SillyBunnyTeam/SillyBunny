export const IN_CHAT_AGENT_PROMPT_KEY_PREFIX = 'inchat_agent_';
export const RUNTIME_AGENTS_IDENTIFIER = 'sillybunnyRuntimeAgents';

export function isInChatAgentPromptIdentifier(identifier) {
    return String(identifier ?? '').startsWith(IN_CHAT_AGENT_PROMPT_KEY_PREFIX);
}

export function getInChatAgentContributionKind(identifier) {
    const value = String(identifier ?? '');
    if (value.endsWith('tracker_echo_guard')) return 'guard';
    if (value.startsWith('inchat_agent_companion_history_')) return 'retained-history';
    if (value.startsWith('inchat_agent_companion_')) return 'feedback';
    return 'inline';
}

export function instrumentInChatAgentPromptValue(value, startMarker, endMarker) {
    const source = String(value ?? '').trim();
    const leadingTrim = source.match(/^{{trim}}/i)?.[0] ?? '';
    const trailingTrim = source.match(/{{trim}}$/i)?.[0] ?? '';
    const contentStart = leadingTrim.length;
    const contentEnd = source.length - trailingTrim.length;

    if (contentEnd < contentStart) {
        return `${source}${startMarker}${endMarker}`;
    }

    return `${source.slice(0, contentStart)}${startMarker}${source.slice(contentStart, contentEnd)}${endMarker}${source.slice(contentEnd)}`;
}

export function collectInChatAgentInspectionRecords(messages = []) {
    const records = [];

    for (const message of messages) {
        if (isInChatAgentPromptIdentifier(message?.identifier) && typeof message?.content === 'string' && message.content) {
            records.push({
                identifier: message.identifier,
                name: message.displayName || message.identifier,
                role: message.role,
                content: message.content,
                kind: getInChatAgentContributionKind(message.identifier),
            });
        }

        if (Array.isArray(message?.agentContributions)) {
            for (const contribution of message.agentContributions) {
                if (typeof contribution?.content !== 'string' || !contribution.content) continue;
                records.push({
                    identifier: String(contribution.identifier ?? ''),
                    name: String(contribution.name ?? '').trim() || String(contribution.identifier ?? ''),
                    role: contribution.role,
                    content: contribution.content,
                    kind: contribution.kind || getInChatAgentContributionKind(contribution.identifier),
                });
            }
        }
    }

    return records;
}
