const HORIZONTAL_WHITESPACE = /[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/;
const WHITESPACE = /\s/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const FENCE_OPENING = /^[ \t]*(`{3,}|~{3,})([\s\S]*)$/;
const MARKS_ONLY_LINE = /^[\s*_-]*$/;
const BULLET_MARKER = /^(\s*)\*\s/;
const MARK_ESCAPES = new Set(['\\', '*', '_']);

/**
 * @param {string} line
 * @returns {{ start: number, end: number }[]} Inline code spans in order, each from its opening backticks to the end of its closing backticks.
 */
function findCodeSpans(line) {
    if (!line.includes('`')) {
        return [];
    }

    const runs = [];
    for (let index = 0; index < line.length;) {
        if (line[index] !== '`') {
            index++;
            continue;
        }
        let end = index + 1;
        while (line[end] === '`') {
            end++;
        }
        runs.push({ start: index, end });
        index = end;
    }

    const closers = new Array(runs.length);
    const nextRunByLength = new Map();
    for (let run = runs.length - 1; run >= 0; run--) {
        const length = runs[run].end - runs[run].start;
        closers[run] = nextRunByLength.get(length);
        nextRunByLength.set(length, run);
    }

    const spans = [];
    for (let run = 0; run < runs.length;) {
        const closer = closers[run];
        if (closer === undefined) {
            run++;
            continue;
        }
        spans.push({ start: runs[run].start, end: runs[closer].end });
        run = closer + 1;
    }
    return spans;
}

function isWordCharacter(char) {
    return char !== undefined && WORD_CHARACTER.test(char);
}

function fixEmphasisSpacing(line) {
    if (!line.includes('*') && !line.includes('_')) {
        return line;
    }

    const codeSpans = findCodeSpans(line);
    const openers = [];
    const topOpenerByKey = new Map();
    let removed = null;
    let span = 0;

    for (let index = 0; index < line.length;) {
        if (span < codeSpans.length && index >= codeSpans[span].start) {
            index = codeSpans[span].end;
            span++;
            continue;
        }

        const char = line[index];
        if (char === '\\' && MARK_ESCAPES.has(line[index + 1])) {
            index += 2;
            continue;
        }
        if (char !== '*' && char !== '_') {
            index++;
            continue;
        }

        const start = index;
        while (line[index] === char) {
            index++;
        }
        const before = line[start - 1];
        const after = line[index];
        if (char === '_' && isWordCharacter(before) && isWordCharacter(after)) {
            continue;
        }

        const canOpen = after !== undefined && !WHITESPACE.test(after);
        const canClose = before !== undefined && !WHITESPACE.test(before);
        // A run with whitespace on both sides is a broken mark. It closes the nearest opener, as in "*text *", or opens, as in "* text*".
        const floating = !canOpen && !canClose;
        const key = char + (index - start);

        if (canClose || floating) {
            const top = topOpenerByKey.get(key);
            if (top !== undefined && openers[top].contentStart < start) {
                const opener = openers[top];
                let from = opener.end;
                let to = start;
                while (HORIZONTAL_WHITESPACE.test(line[from])) {
                    from++;
                }
                while (HORIZONTAL_WHITESPACE.test(line[to - 1])) {
                    to--;
                }
                if (from > opener.end || to < start) {
                    removed ??= new Uint8Array(line.length);
                    removed.fill(1, opener.end, from);
                    removed.fill(1, to, start);
                }
                for (let dropped = openers.length - 1; dropped >= top; dropped--) {
                    const { key: droppedKey, below } = openers[dropped];
                    if (below === undefined) {
                        topOpenerByKey.delete(droppedKey);
                    } else {
                        topOpenerByKey.set(droppedKey, below);
                    }
                }
                openers.length = top;
                continue;
            }
        }

        if (canOpen || floating) {
            let contentStart = index;
            while (contentStart < line.length && WHITESPACE.test(line[contentStart])) {
                contentStart++;
            }
            openers.push({ key, end: index, contentStart, below: topOpenerByKey.get(key) });
            topOpenerByKey.set(key, openers.length - 1);
        }
    }

    if (!removed) {
        return line;
    }

    let fixed = '';
    let keptFrom = 0;
    for (let index = 0; index < line.length; index++) {
        if (removed[index]) {
            fixed += line.slice(keptFrom, index);
            keptFrom = index + 1;
        }
    }
    return fixed + line.slice(keptFrom);
}

function closeUnpairedMarks(line) {
    if (!line.includes('*') && !line.includes('"')) {
        return line;
    }

    const codeSpans = findCodeSpans(line);
    const bullet = BULLET_MARKER.exec(line);
    const bulletIndex = bullet ? bullet[1].length : -1;
    let stars = 0;
    let quotes = 0;
    let span = 0;

    for (let index = 0; index < line.length;) {
        if (span < codeSpans.length && index >= codeSpans[span].start) {
            index = codeSpans[span].end;
            span++;
            continue;
        }
        if (line[index] === '*' && index !== bulletIndex) {
            stars++;
        } else if (line[index] === '"') {
            quotes++;
        }
        index++;
    }

    // Both checks start from the unchanged line, so a line with an odd count of both marks only gets the quote, as upstream does.
    let fixed = line;
    if (stars % 2 !== 0) {
        fixed = line.trimEnd() + '*';
    }
    if (quotes % 2 !== 0) {
        fixed = line.trimEnd() + '"';
    }
    return fixed;
}

function getFenceOpening(line) {
    const match = FENCE_OPENING.exec(line);
    if (!match || (match[1][0] === '`' && match[2].includes('`'))) {
        return '';
    }
    return match[1];
}

function closesFence(line, fence) {
    const marks = line.trim();
    return marks.length >= fence.length && marks === fence[0].repeat(marks.length);
}

/**
 * Fixes the spacing of Markdown emphasis and, for display, closes unpaired `*` and `"` marks.
 * The spacing fix pairs whole `*` and `_` runs on one line and only deletes the horizontal whitespace
 * directly inside a pair, so unpaired runs such as list markers stay as they are.
 * Fenced code, inline code and lines made only of `*`, `_`, `-` and whitespace stay unchanged.
 * @param {string} text Markdown text.
 * @param {boolean} forDisplay Whether the text is only displayed. Stored text gets the spacing fix only.
 * @returns {string} The fixed text.
 */
export function autoFixMarkdown(text, forDisplay) {
    const lines = text.split('\n');
    let fence = '';

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (fence) {
            if (closesFence(line, fence)) {
                fence = '';
            }
            continue;
        }

        fence = getFenceOpening(line);
        if (fence || MARKS_ONLY_LINE.test(line)) {
            continue;
        }

        const spaced = fixEmphasisSpacing(line);
        lines[index] = forDisplay ? closeUnpairedMarks(spaced) : spaced;
    }

    return lines.join('\n');
}
