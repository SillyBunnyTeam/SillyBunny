export const MAX_INJECT_REGEX_LENGTH = 1000;
export const MAX_INJECT_SOURCE_LENGTH = 100 * 1024;
export const MAX_INJECT_MATCHES = 10;

function assertSafeRepetition(pattern) {
    const stack = [{ hasAlternation: false, hasRepetition: false }];
    let inClass = false;
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index];
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === '[') inClass = true;
        if (char === ']' && inClass) inClass = false;
        if (inClass) continue;
        if (char === '(') {
            stack.push({ hasAlternation: false, hasRepetition: false });
            continue;
        }
        if (char === '|') stack.at(-1).hasAlternation = true;
        if (char === '*' || char === '+' || char === '{') stack.at(-1).hasRepetition = true;
        if (char !== ')' || stack.length === 1) continue;

        const group = stack.pop();
        let cursor = index + 1;
        if (pattern[cursor] === '?') cursor += 1;
        const repeated = pattern[cursor] === '*' || pattern[cursor] === '+' || pattern[cursor] === '{';
        if (repeated && (group.hasAlternation || group.hasRepetition)) {
            throw new Error('Inject regex contains unsafe repeated groups');
        }
        if (repeated || group.hasRepetition) stack.at(-1).hasRepetition = true;
    }
}

export function compileInjectRegex(pattern, flags = 'gi') {
    if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('Inject regex is empty');
    if (pattern.length > MAX_INJECT_REGEX_LENGTH) throw new Error(`Inject regex exceeds ${MAX_INJECT_REGEX_LENGTH} characters`);
    if (/\\[1-9]/.test(pattern)) throw new Error('Inject regex backreferences are not supported');
    if (/\((?:\\.|[^()])*[*+](?:\\.|[^()])*\)\s*(?:[*+]\s*|\{)/.test(pattern)) {
        throw new Error('Inject regex contains nested repetition');
    }
    if (/(?:\.\*(?:[^|)]|\\.)*){2,}/.test(pattern)) throw new Error('Inject regex contains repeated wildcards');
    assertSafeRepetition(pattern);
    return new RegExp(pattern, flags);
}

export function boundedInjectSource(value) {
    return String(value ?? '').slice(0, MAX_INJECT_SOURCE_LENGTH);
}
