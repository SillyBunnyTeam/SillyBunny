// The small part of SVG path syntax that VTracer writes: absolute M, L, C and Z. Anything else is an error, not a guess.

const COMMAND_ARGUMENTS = { M: 2, L: 2, C: 6, Z: 0 };
const TOKEN = /([MLCZ])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;

/**
 * @param {string} d path data
 * @returns {{ command: 'M' | 'L' | 'C' | 'Z', points: number[][] }[]} one entry per command, its arguments as [x, y] pairs
 */
export function parsePath(d) {
    const stripped = d.replace(TOKEN, '').replace(/[\s,]/g, '');
    if (stripped.length > 0) {
        throw new Error(`Path data has something this tool does not read ("${stripped[0]}"); only M, L, C and Z in absolute form are supported.`);
    }
    const commands = [];
    let command;
    let numbers = [];
    const flush = () => {
        if (command === undefined) {
            return;
        }
        const size = COMMAND_ARGUMENTS[command];
        if (size === 0) {
            if (numbers.length > 0) {
                throw new Error('Path command Z takes no numbers.');
            }
            commands.push({ command, points: [] });
        } else if (numbers.length === 0 || numbers.length % size !== 0) {
            throw new Error(`Path command ${command} has ${numbers.length} numbers, which does not fit it.`);
        }
        for (let at = 0; size > 0 && at < numbers.length; at += size) {
            const points = [];
            for (let offset = 0; offset < size; offset += 2) {
                points.push([numbers[at + offset], numbers[at + offset + 1]]);
            }
            // Extra pairs after M are lines, as in the SVG grammar.
            commands.push({ command: at > 0 && command === 'M' ? 'L' : command, points });
        }
        numbers = [];
    };
    for (const [, letter, number] of d.matchAll(TOKEN)) {
        if (letter) {
            flush();
            command = letter.toUpperCase();
            if (letter !== command) {
                throw new Error(`Path command "${letter}" is relative; only absolute M, L, C and Z are supported.`);
            }
        } else if (command === undefined) {
            throw new Error('Path data starts with a number instead of a command.');
        } else {
            numbers.push(Number(number));
        }
    }
    flush();
    return commands;
}

/** @param {ReturnType<typeof parsePath>} commands */
export const translatePath = (commands, dx, dy) => commands.map(({ command, points }) => ({ command, points: points.map(([x, y]) => [x + dx, y + dy]) }));

/** A number as short as it can be at `decimals` places: no trailing zeros, no leading zero, no negative zero. */
export function formatNumber(value, decimals) {
    const factor = 10 ** decimals;
    const rounded = Math.round(value * factor) / factor;
    if (rounded === 0) {
        return '0';
    }
    return String(rounded).replace(/^(-?)0\./, '$1.');
}

const isNumber = (token) => !/^[a-zA-Z]$/.test(token);

/** Writes letters and numbers with the fewest separators the SVG grammar allows. */
function writeTokens(tokens) {
    return tokens.reduce((text, token, at) => {
        if (at === 0 || !isNumber(token) || !isNumber(tokens[at - 1])) {
            return text + token;
        }
        const needsSpace = !(token.startsWith('-') || (token.startsWith('.') && tokens[at - 1].includes('.')));
        return text + (needsSpace ? ' ' : '') + token;
    }, '');
}

/**
 * Path data in its shortest form: each subpath starts with an absolute M and goes on in relative commands, whose offsets are taken
 * from the rounded position so rounding never adds up along the path. A command letter is not repeated when the next command is the same.
 * @param {ReturnType<typeof parsePath>} commands
 * @param {number} [decimals]
 */
export function serialisePath(commands, decimals = 1) {
    const factor = 10 ** decimals;
    const round = (value) => Math.round(value * factor) / factor;
    const tokens = [];
    let current = [0, 0];
    let subpathStart = current;
    let lastLetter;
    for (const { command, points } of commands) {
        if (command === 'Z') {
            tokens.push('z');
            current = subpathStart;
            lastLetter = 'z';
            continue;
        }
        const rounded = points.map(([x, y]) => [round(x), round(y)]);
        if (command === 'M') {
            tokens.push('M', ...rounded[0].map((value) => formatNumber(value, decimals)));
            current = rounded[0];
            subpathStart = current;
            lastLetter = 'M';
            continue;
        }
        // The points of a segment are all offsets from where the segment starts, which is what lowercase l and c mean.
        const letter = command.toLowerCase();
        if (letter !== lastLetter) {
            tokens.push(letter);
        }
        tokens.push(...rounded.flatMap(([x, y]) => [formatNumber(x - current[0], decimals), formatNumber(y - current[1], decimals)]));
        current = rounded[rounded.length - 1];
        lastLetter = letter;
    }
    return writeTokens(tokens);
}

/**
 * The `<path>` elements of an SVG as VTracer writes it: path data, fill and the translate it puts on each path.
 * @param {string} svg
 * @returns {{ d: string, fill: string, dx: number, dy: number }[]}
 */
export function readVtracerPaths(svg) {
    return [...svg.matchAll(/<path\b([^>]*)\/?>/g)].map(([, attributes]) => {
        const d = /\sd="([^"]*)"/.exec(` ${attributes}`)?.[1];
        const fill = /\sfill="([^"]*)"/.exec(` ${attributes}`)?.[1];
        const transform = /\stransform="([^"]*)"/.exec(` ${attributes}`)?.[1];
        if (d === undefined || fill === undefined) {
            throw new Error('A path in the traced SVG has no d or no fill.');
        }
        const translate = transform === undefined ? [0, 0] : /^translate\(\s*(-?[\d.e+-]+)[,\s]+(-?[\d.e+-]+)\s*\)$/.exec(transform)?.slice(1).map(Number);
        if (!translate) {
            throw new Error(`A path in the traced SVG has a transform this tool does not read: ${transform}.`);
        }
        return { d, fill, dx: translate[0], dy: translate[1] };
    });
}
