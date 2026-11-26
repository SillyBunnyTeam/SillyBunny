const RENDER_KEY_SEPARATOR = '\u001f';

/** The identity of what the timeline draws: persona, character, group and chat. */
export function buildConversationRenderKey(avatar, groupId, chatId, personaId) {
    return [personaId || '', avatar || '', groupId || '', chatId || ''].join(RENDER_KEY_SEPARATOR);
}

/** The key of the conversation that a render key belongs to: persona, character and group, without the chat. Empty for the empty key. */
export function getRenderKeyConversation(renderKey) {
    const chatStart = String(renderKey || '').lastIndexOf(RENDER_KEY_SEPARATOR);
    return chatStart < 0 ? '' : renderKey.slice(0, chatStart);
}
