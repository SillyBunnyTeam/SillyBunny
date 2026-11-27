export function truncateConversationReplyPreview(value, maxLength = 160) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function stripPreviewText(messageText) {
    // `[^<>]` ends a tag at the next "<": with `[^>]` every lone "<" scanned to the end of the text, so the time grew with its square.
    return String(messageText || '')
        .replace(/<[^<>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 130);
}
