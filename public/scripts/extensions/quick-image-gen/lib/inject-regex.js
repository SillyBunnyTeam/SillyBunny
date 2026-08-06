export const MAX_INJECT_REGEX_LENGTH = 1000;
export const MAX_INJECT_SOURCE_LENGTH = 100 * 1024;
export const MAX_INJECT_MATCHES = 10;
export const MAX_AUTOMATIC_INJECT_MATCHES = 1;

function assertSafeRepetition(pattern, flags) {
    const unicodeEscapes = typeof flags === 'string' && (flags.includes('u') || flags.includes('v'));
    const unicodeSets = typeof flags === 'string' && flags.includes('v');

    function readQuantifier(index) {
        const char = pattern[index];
        let min;
        let max;
        let cursor = index + 1;

        if (char === '*') {
            min = 0;
            max = Infinity;
        } else if (char === '+') {
            min = 1;
            max = Infinity;
        } else if (char === '?') {
            min = 0;
            max = 1;
        } else if (char === '{') {
            const minStart = cursor;
            while (/\d/.test(pattern[cursor] ?? '')) cursor += 1;
            if (cursor === minStart) return null;
            min = Number(pattern.slice(minStart, cursor));
            if (pattern[cursor] === '}') {
                max = min;
                cursor += 1;
            } else if (pattern[cursor] === ',') {
                cursor += 1;
                const maxStart = cursor;
                while (/\d/.test(pattern[cursor] ?? '')) cursor += 1;
                max = cursor === maxStart ? Infinity : Number(pattern.slice(maxStart, cursor));
                if (pattern[cursor] !== '}') return null;
                cursor += 1;
            } else {
                return null;
            }
        } else {
            return null;
        }

        if (pattern[cursor] === '?') cursor += 1;
        return { end: cursor, min, max };
    }

    function skipEscape(index) {
        const escaped = pattern[index + 1];
        if (escaped === undefined) return index + 1;
        if (/[1-9]/.test(escaped) || (escaped === 'k' && pattern[index + 2] === '<')) {
            throw new Error('Inject regex backreferences are not supported');
        }

        if (escaped === 'x' && /^[\da-f]{2}$/i.test(pattern.slice(index + 2, index + 4))) return index + 4;
        if (escaped === 'u' && /^[\da-f]{4}$/i.test(pattern.slice(index + 2, index + 6))) return index + 6;
        if (unicodeEscapes && escaped === 'u' && pattern[index + 2] === '{') {
            const end = pattern.indexOf('}', index + 3);
            if (end !== -1 && /^[\da-f]+$/i.test(pattern.slice(index + 3, end))) return end + 1;
        }
        if (unicodeEscapes && (escaped === 'p' || escaped === 'P') && pattern[index + 2] === '{') {
            const end = pattern.indexOf('}', index + 3);
            if (end !== -1) return end + 1;
        }
        return index + 2;
    }

    function analyze(start, closesGroup = false) {
        let index = start;
        let branchNullable = true;
        let branchWildcards = 0;
        let anyBranchNullable = false;
        let maxWildcards = 0;
        let hasAlternation = false;
        let hasQuantifier = false;
        let hasDirectQuantifier = false;

        while (index < pattern.length) {
            const char = pattern[index];
            if (char === ')' && closesGroup) {
                return {
                    end: index + 1,
                    closed: true,
                    nullable: anyBranchNullable || branchNullable,
                    maxWildcards: Math.max(maxWildcards, branchWildcards),
                    hasAlternation,
                    hasQuantifier,
                    hasDirectQuantifier,
                };
            }
            if (char === '|') {
                anyBranchNullable ||= branchNullable;
                maxWildcards = Math.max(maxWildcards, branchWildcards);
                branchNullable = true;
                branchWildcards = 0;
                hasAlternation = true;
                index += 1;
                continue;
            }

            let atom = {
                nullable: char === '^' || char === '$',
                maxWildcards: 0,
                hasAlternation: false,
                hasQuantifier: false,
                hasDirectQuantifier: false,
                wildcard: char === '.',
            };

            if (char === '\\') {
                atom.nullable = pattern[index + 1] === 'b' || pattern[index + 1] === 'B';
                index = skipEscape(index);
            } else if (char === '[') {
                let depth = 1;
                index += 1;
                while (index < pattern.length && depth > 0) {
                    if (pattern[index] === '\\') {
                        index = skipEscape(index);
                    } else {
                        if (unicodeSets && pattern[index] === '[') depth += 1;
                        if (pattern[index] === ']') depth -= 1;
                        index += 1;
                    }
                }
            } else if (char === '(') {
                let contentStart = index + 1;
                let assertion = false;
                if (pattern[contentStart] === '?') {
                    const marker = pattern[contentStart + 1];
                    if (marker === ':' || marker === '=' || marker === '!') {
                        assertion = marker !== ':';
                        contentStart += 2;
                    } else if (marker === '<' && (pattern[contentStart + 2] === '=' || pattern[contentStart + 2] === '!')) {
                        assertion = true;
                        contentStart += 3;
                    } else if (marker === '<') {
                        const nameEnd = pattern.indexOf('>', contentStart + 2);
                        if (nameEnd !== -1) contentStart = nameEnd + 1;
                    } else {
                        let modifierEnd = contentStart + 1;
                        while ('dimsuv-'.includes(pattern[modifierEnd] ?? '')) modifierEnd += 1;
                        if (pattern[modifierEnd] === ':') contentStart = modifierEnd + 1;
                    }
                }

                const group = analyze(contentStart, true);
                atom = {
                    nullable: assertion || group.nullable,
                    maxWildcards: group.maxWildcards,
                    hasAlternation: group.hasAlternation,
                    hasQuantifier: group.hasQuantifier,
                    hasDirectQuantifier: group.hasDirectQuantifier,
                    wildcard: false,
                };
                index = group.end;
            } else {
                index += 1;
            }

            const quantifier = readQuantifier(index);
            if (quantifier) {
                if (quantifier.max > 1 && atom.hasQuantifier) {
                    const message = atom.hasDirectQuantifier ? 'nested repetition' : 'unsafe repeated groups';
                    throw new Error(`Inject regex contains ${message}`);
                }
                if (quantifier.max > 1 && (atom.hasAlternation || atom.nullable)) {
                    throw new Error('Inject regex contains unsafe repeated groups');
                }
                if (atom.wildcard && quantifier.min === 0 && quantifier.max === Infinity) atom.maxWildcards = 1;
                atom.nullable = quantifier.min === 0 || atom.nullable;
                atom.hasQuantifier = true;
                hasDirectQuantifier = true;
                index = quantifier.end;
            }

            branchNullable &&= atom.nullable;
            branchWildcards += atom.maxWildcards;
            if (branchWildcards > 1) throw new Error('Inject regex contains repeated wildcards');
            hasAlternation ||= atom.hasAlternation;
            hasQuantifier ||= atom.hasQuantifier;
        }

        return {
            end: index,
            closed: false,
            nullable: anyBranchNullable || branchNullable,
            maxWildcards: Math.max(maxWildcards, branchWildcards),
            hasAlternation,
            hasQuantifier,
            hasDirectQuantifier,
        };
    }

    analyze(0);
}

export function compileInjectRegex(pattern, flags = 'gi') {
    if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('Inject regex is empty');
    if (pattern.length > MAX_INJECT_REGEX_LENGTH) throw new Error(`Inject regex exceeds ${MAX_INJECT_REGEX_LENGTH} characters`);
    assertSafeRepetition(pattern, flags);
    return new RegExp(pattern, flags);
}

export function boundedInjectSource(value) {
    return String(value ?? '').slice(0, MAX_INJECT_SOURCE_LENGTH);
}

export function limitAutomaticInjectMatches(matches, automatic = false) {
    const list = Array.isArray(matches) ? matches : [];
    return automatic ? list.slice(0, MAX_AUTOMATIC_INJECT_MATCHES) : list;
}
