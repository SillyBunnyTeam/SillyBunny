export function parseAvatarList(value) {
    return String(value || '')
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);
}

export function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasMentionBoundaryMatch(messageText, mention) {
    const needle = String(mention || '').toLowerCase().trim();
    if (!messageText || !needle) {
        return false;
    }

    const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}($|[^a-z0-9_])`, 'i');
    return pattern.test(messageText);
}

export function getCharacterMentionHandles(character) {
    const charName = String(character?.name || '').trim();
    if (!charName) {
        return [];
    }

    const parts = charName.split(/[\s_-]+/).filter(part => part.length > 2);
    return Array.from(new Set([
        `@${charName}`,
        `@${charName.replace(/[\s_-]+/g, '')}`,
        ...parts.map(part => `@${part}`),
    ].map(handle => handle.trim()).filter(handle => handle.length > 1)));
}

export function isCharacterMentionedInText(character, text, candidates = []) {
    const messageText = String(text || '').toLowerCase();
    const charName = String(character?.name || '').toLowerCase().trim();
    if (!messageText || !charName) {
        return false;
    }

    if (getCharacterMentionHandles(character).some(handle => hasMentionBoundaryMatch(messageText, handle))) {
        return true;
    }

    if (hasMentionBoundaryMatch(messageText, charName)) {
        return true;
    }

    const candidateList = Array.isArray(candidates) && candidates.length ? candidates : [character];
    return charName
        .split(/[\s_-]+/)
        .filter(part => part.length > 2)
        .filter((part) => {
            const partMatches = candidateList.filter(candidate => String(candidate?.name || '').toLowerCase().split(/[\s_-]+/).includes(part));
            return partMatches.length === 1;
        })
        .some(part => hasMentionBoundaryMatch(messageText, part));
}

export function getLastPartnerMessageIndex(thread, partner) {
    for (let index = thread.length - 1; index >= 0; index--) {
        const message = thread[index];
        if (message?.extra?.partner_avatar === partner.avatar) {
            return index;
        }
    }

    return -1;
}

export function getRecentlySilentMentionedPartnerFromThread(thread, partners, recentWindow) {
    const recentMessages = thread.slice(-recentWindow);
    const mentionedPartner = partners.find(partner => recentMessages.some(message => isCharacterMentionedInText(partner, message?.mes || '', partners)));
    if (!mentionedPartner) {
        return null;
    }

    const lastMentionIndex = recentMessages.reduce((lastIndex, message, index) => {
        return isCharacterMentionedInText(mentionedPartner, message?.mes || '', partners) ? index : lastIndex;
    }, -1);
    const spokeAfterMention = recentMessages.slice(lastMentionIndex + 1).some((message) => {
        const isPartnerMessage = message?.extra?.partner_avatar === mentionedPartner.avatar;
        return isPartnerMessage && !['user', 'system'].includes(message.role);
    });
    return spokeAfterMention ? null : mentionedPartner;
}

export function stripSpeakerPrefixText(messageText, speakerName, normalize = value => value) {
    const text = String(messageText || '');
    const namePattern = escapeRegExp(speakerName);
    const charRegex = /^\s*(?:\*\*)?\{\{char\}\}(?:\*\*)?\s*[:：-](?:\*\*)?\s*/i;
    const speakerRegex = namePattern ? new RegExp(`^\\s*(?:\\*\\*)?${namePattern}(?:\\*\\*)?\\s*[:：-](?:\\*\\*)?\\s*`, 'i') : null;

    const lines = text.split(/\r?\n/);
    const cleanedLines = lines.map(line => {
        let currentLine = line;
        let changed = true;
        while (changed) {
            changed = false;
            const prevChar = currentLine;
            currentLine = currentLine.replace(charRegex, '');
            if (currentLine !== prevChar) {
                changed = true;
                continue;
            }
            if (speakerRegex) {
                const prevSpeaker = currentLine;
                currentLine = currentLine.replace(speakerRegex, '');
                if (currentLine !== prevSpeaker) {
                    changed = true;
                }
            }
        }
        return currentLine;
    });

    return normalize(cleanedLines.join('\n').trim());
}

export function getSpeakerPrefixMatch(messageText, speakers = []) {
    const text = String(messageText || '');
    const candidates = (Array.isArray(speakers) ? speakers : [])
        .map(speaker => ({ speaker, name: String(speaker?.name || '').trim() }))
        .filter(candidate => candidate.name)
        .sort((left, right) => right.name.length - left.name.length);

    for (const candidate of candidates) {
        const speakerRegex = new RegExp(`^\\s*(?:\\*\\*)?${escapeRegExp(candidate.name)}(?:\\*\\*)?\\s*[:：-](?:\\*\\*)?\\s*`, 'i');
        const match = text.match(speakerRegex);
        if (match) {
            return {
                speaker: candidate.speaker,
                text: text.slice(match[0].length).trim(),
            };
        }
    }

    return null;
}
