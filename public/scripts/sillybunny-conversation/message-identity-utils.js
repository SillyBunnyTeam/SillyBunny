function normalizeConversationRevisionValue(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeConversationRevisionValue);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = normalizeConversationRevisionValue(value[key]);
            return result;
        }, {});
    }
    return value;
}

export function getConversationMessageRevision(message) {
    return JSON.stringify(normalizeConversationRevisionValue({
        id: message?.id || '',
        name: message?.name || '',
        role: message?.role || '',
        mes: message?.mes || '',
        created_at: message?.created_at || '',
        extra: message?.extra || {},
    }));
}

export function getConversationMessagesRevision(messages) {
    return JSON.stringify((Array.isArray(messages) ? messages : []).map(getConversationMessageRevision));
}
