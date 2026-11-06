export function mentionSearchState(value, choices) {
    const source = String(value ?? '');
    const completeMentions = [];
    const mentionPattern = /(?:^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
    for (const match of source.matchAll(mentionPattern)) {
        let label = match[1] ?? match[2];
        if (match[1] !== undefined) {
            try {
                label = JSON.parse(`"${match[1]}"`);
            } catch {
                label = match[1].replace(/\\(["\\])/g, '$1');
            }
        }
        const choice = choices.find(item => item.name.localeCompare(label, undefined, { sensitivity: 'accent' }) === 0);
        completeMentions.push(choice ?? { name: label, avatars: [], missing: true });
    }
    const activeMatch = source.match(/(?:^|\s)@(?:"((?:\\.|[^"\\])*)|([^\s]*))$/);
    const active = activeMatch
        ? {
            fragment: (activeMatch[1] ?? activeMatch[2] ?? '').replace(/\\(["\\])/g, '$1'),
            start: activeMatch.index + activeMatch[0].lastIndexOf('@'),
        }
        : null;
    const searchableSource = active ? source.slice(0, active.start) : source;
    const text = searchableSource.replace(mentionPattern, ' ');
    return { text: text.trim(), mentions: completeMentions, active };
}

export function mentionedRows(rows, mentions) {
    const valid = mentions.filter(mention => !mention.missing);
    if (valid.length === 0) {
        return mentions.some(mention => mention.missing) ? [] : rows;
    }
    const avatars = new Set(valid.flatMap(mention => mention.avatars));
    return rows.filter(row => row.kind === 'solo' && avatars.has(row.avatar));
}

export function mentionChoices(ctx) {
    const choices = new Map();
    for (const character of ctx.characters ?? []) {
        const name = typeof character?.name === 'string' ? character.name.trim() : '';
        if (!name || !character.avatar) {
            continue;
        }
        const key = name.toLocaleLowerCase();
        const choice = choices.get(key) ?? { name, avatars: [] };
        choice.avatars.push(character.avatar);
        choices.set(key, choice);
    }
    return [...choices.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function fuzzyMentionChoices(choices, query, limit = 8) {
    const needle = String(query ?? '').trim().toLocaleLowerCase();
    if (!needle) {
        return choices.slice(0, limit);
    }
    const ranked = [];
    for (const choice of choices) {
        const name = choice.name.toLocaleLowerCase();
        const direct = name.indexOf(needle);
        if (direct >= 0) {
            ranked.push({ choice, score: direct * 10 + name.length - needle.length });
            continue;
        }
        let cursor = 0;
        let gaps = 0;
        for (const character of needle) {
            const match = name.indexOf(character, cursor);
            if (match < 0) {
                cursor = -1;
                break;
            }
            gaps += match - cursor;
            cursor = match + 1;
        }
        if (cursor >= 0) {
            ranked.push({ choice, score: 100 + gaps * 10 + name.length - needle.length });
        }
    }
    return ranked
        .sort((left, right) => left.score - right.score || left.choice.name.localeCompare(right.choice.name))
        .slice(0, limit)
        .map(item => item.choice);
}
