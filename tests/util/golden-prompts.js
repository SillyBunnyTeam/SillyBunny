import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const utilDirectory = path.dirname(fileURLToPath(import.meta.url));

export const GOLDEN_PROMPTS_DIR = path.resolve(utilDirectory, '..', 'fixtures', 'golden-prompts');
export const UPDATE_GOLDEN_ENV_VAR = 'UPDATE_GOLDEN_PROMPTS';

const CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MESSAGE_PRIORITY_KEYS = ['role', 'name', 'content'];

/**
 * Shared text anchors used by the fixture cast so every golden file can be checked for real assembled sections.
 */
export const GOLDEN_FIXTURE_MARKERS = Object.freeze({
    charName: 'Lyra Vance',
    userName: 'Rowan Hale',
    charDescription: 'Lyra Vance is a clockwork cartographer who repairs brass astrolabes in the lantern district of Oakhaven.',
    charPersonality: 'Analytical, dry-humored, fiercely protective of old maps.',
    charScenario: 'Rain taps against the leaded glass of Lyra\'s workshop while Rowan Hale brings a torn star chart to her bench.',
    charExampleUser: 'How old is this brass astrolabe?',
    charExampleAssistant: '"Older than the harbor wall," Lyra says, turning a notched ring. "Keep your sleeve clear of the oil."',
    charSystemPrompt: 'Stay strictly in character as Lyra Vance, grounding scenes in tactile workshop detail.',
    mainPromptOriginal: 'Write Lyra Vance\'s next reply in a fictional chat between Lyra Vance and Rowan Hale.',
    charPostHistory: 'End Lyra Vance\'s reply with a concrete physical action inside the workshop.',
    personaDescription: 'Rowan Hale is a coastal courier carrying sealed nautical charts in a waxed-canvas satchel.',
    worldInfoBefore: '[Lore: Oakhaven astrolabes are calibrated to the twin harbor beacons rather than true north.]',
    worldInfoAfter: '[Lore: The Lantern Guild closes the canal locks whenever fog horns sound three times.]',
    worldInfoAtDepth: '[Lore at depth 1: The eastern harbor beacon uses a green Fresnel lens stolen from an old wreck.]',
    worldInfoUntriggered: '[UNTRIGGERED LORE: Must not appear in the prompt.]',
    authorsNote: '[Author\'s Note: Keep the pacing measured and highlight the smell of rain, brass oil, and wet parchment.]',
    chatTurn0: 'Lyra sets her loupe beside the brass compass and looks up at Rowan Hale. "Put the chart under the amber lamp before the ink runs."',
    chatTurn1: 'I unroll the damp parchment across her bench. "The harbor master said your astrolabe could verify these lantern-district bearings."',
    chatTurn2: 'Lyra traces the salted margin with a brass divider. "The bearings are shifted three degrees east. Tell me which tower the cutter sighted first."',
    chatTurn3: 'We sighted the eastern beacon just before the squall broke.',
    minimalCharName: 'Bramwell Finch',
    minimalDescription: 'Bramwell Finch tends the lighthouse on Gull Rock and brews strong black tea.',
    minimalMainPrompt: 'Write Bramwell Finch\'s next reply in a fictional chat between Bramwell Finch and Rowan Hale.',
    minimalTurn0: '"Step inside out of the spray," Bramwell says, gesturing toward the kettle.',
    minimalTurn1: 'Good evening, Bramwell. Is the lantern lit?',
    claudePrefill: 'Lyra Vance sets the divider down and replies:',
});

const FULL_ASSEMBLY_MARKERS = Object.freeze([
    GOLDEN_FIXTURE_MARKERS.charSystemPrompt,
    GOLDEN_FIXTURE_MARKERS.mainPromptOriginal,
    GOLDEN_FIXTURE_MARKERS.worldInfoBefore,
    GOLDEN_FIXTURE_MARKERS.personaDescription,
    GOLDEN_FIXTURE_MARKERS.charDescription,
    GOLDEN_FIXTURE_MARKERS.charPersonality,
    GOLDEN_FIXTURE_MARKERS.charScenario,
    GOLDEN_FIXTURE_MARKERS.worldInfoAfter,
    GOLDEN_FIXTURE_MARKERS.charExampleUser,
    GOLDEN_FIXTURE_MARKERS.charExampleAssistant,
    GOLDEN_FIXTURE_MARKERS.chatTurn0,
    GOLDEN_FIXTURE_MARKERS.chatTurn1,
    GOLDEN_FIXTURE_MARKERS.authorsNote,
    GOLDEN_FIXTURE_MARKERS.chatTurn2,
    GOLDEN_FIXTURE_MARKERS.worldInfoAtDepth,
    GOLDEN_FIXTURE_MARKERS.chatTurn3,
    GOLDEN_FIXTURE_MARKERS.charPostHistory,
]);

/**
 * Committed golden prompt scenarios. Each entry maps 1:1 to a JSON fixture under `tests/fixtures/golden-prompts/`.
 */
export const GOLDEN_SCENARIOS = Object.freeze([
    Object.freeze({
        id: 'chat-completion-openai-full',
        title: 'Chat Completion — Standard OpenAI (full assembly)',
        kind: 'chat-completion',
        endpoint: '/api/backends/chat-completions/generate',
        requiredSnippets: FULL_ASSEMBLY_MARKERS,
        forbiddenSnippets: Object.freeze([
            GOLDEN_FIXTURE_MARKERS.worldInfoUntriggered,
        ]),
    }),
    Object.freeze({
        id: 'chat-completion-claude-anthropic',
        title: 'Chat Completion — Claude / Anthropic source',
        kind: 'chat-completion',
        endpoint: '/api/backends/chat-completions/generate',
        requiredSnippets: FULL_ASSEMBLY_MARKERS,
        forbiddenSnippets: Object.freeze([
            GOLDEN_FIXTURE_MARKERS.worldInfoUntriggered,
        ]),
    }),
    Object.freeze({
        id: 'chat-completion-minimal-defaults',
        title: 'Chat Completion — Minimal / Clean defaults',
        kind: 'chat-completion',
        endpoint: '/api/backends/chat-completions/generate',
        requiredSnippets: Object.freeze([
            GOLDEN_FIXTURE_MARKERS.minimalMainPrompt,
            GOLDEN_FIXTURE_MARKERS.minimalDescription,
            GOLDEN_FIXTURE_MARKERS.minimalTurn0,
            GOLDEN_FIXTURE_MARKERS.minimalTurn1,
        ]),
        forbiddenSnippets: Object.freeze([
            '[Example Chat]',
            GOLDEN_FIXTURE_MARKERS.worldInfoBefore,
            GOLDEN_FIXTURE_MARKERS.worldInfoUntriggered,
            GOLDEN_FIXTURE_MARKERS.authorsNote,
            GOLDEN_FIXTURE_MARKERS.personaDescription,
        ]),
    }),
    Object.freeze({
        id: 'text-completion-instruct-llama3',
        title: 'Text Completion — Instruct Mode (Llama 3 Instruct)',
        kind: 'text-completion',
        endpoint: '/api/backends/text-completions/generate',
        requiredSnippets: Object.freeze([
            '<|start_header_id|>system<|end_header_id|>',
            '<|start_header_id|>user<|end_header_id|>',
            '<|start_header_id|>assistant<|end_header_id|>',
            '<|eot_id|>',
            ...FULL_ASSEMBLY_MARKERS,
        ]),
        forbiddenSnippets: Object.freeze([
            GOLDEN_FIXTURE_MARKERS.worldInfoUntriggered,
        ]),
    }),
    Object.freeze({
        id: 'text-completion-story-non-instruct',
        title: 'Text Completion — Story / Non-Instruct Mode',
        kind: 'text-completion',
        endpoint: '/api/backends/text-completions/generate',
        requiredSnippets: Object.freeze([
            '***',
            ...FULL_ASSEMBLY_MARKERS,
            'Lyra Vance:',
        ]),
        forbiddenSnippets: Object.freeze([
            '<|start_header_id|>',
            '<|eot_id|>',
            GOLDEN_FIXTURE_MARKERS.worldInfoUntriggered,
        ]),
    }),
]);

/**
 * Compares two keys using ASCII code-point order so key order never varies by OS locale.
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareKeysAscii(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * Returns whether golden fixture regeneration is explicitly enabled.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function shouldUpdateGoldenPrompts(env = process.env) {
    const raw = String(env?.[UPDATE_GOLDEN_ENV_VAR] ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true';
}

/**
 * Resolves the absolute path to a golden fixture file for a validated scenario id.
 * @param {string} caseId
 * @param {string} [dir]
 * @returns {string}
 */
export function getGoldenFixturePath(caseId, dir = GOLDEN_PROMPTS_DIR) {
    if (typeof caseId !== 'string' || !CASE_ID_PATTERN.test(caseId)) {
        throw new Error(`Invalid golden prompt case id "${caseId}". Expected lowercase kebab-case.`);
    }
    return path.join(dir, `${caseId}.json`);
}

/**
 * Produces a deterministic copy of a captured request body with stable key order.
 * Only keys explicitly listed in `volatileKeys` are replaced; all other fields stay verbatim.
 * @param {unknown} value
 * @param {{ volatileKeys?: Record<string, unknown> }} [options]
 * @returns {unknown}
 */
export function canonicalizeGoldenRequest(value, options = {}) {
    const volatileKeys = options?.volatileKeys ?? {};
    const hasVolatile = Object.keys(volatileKeys).length > 0;

    const visit = (node) => {
        if (typeof node === 'string') {
            return node.replace(/\r\n/g, '\n');
        }
        if (node === null || typeof node !== 'object') {
            return node;
        }
        if (Array.isArray(node)) {
            return node.map(item => (item === undefined ? null : visit(item)));
        }

        const keys = Object.keys(node).filter(key => node[key] !== undefined);
        const isMessageObject = typeof node.role === 'string' && Object.hasOwn(node, 'content');
        keys.sort((left, right) => {
            if (isMessageObject) {
                const leftPriority = MESSAGE_PRIORITY_KEYS.indexOf(left);
                const rightPriority = MESSAGE_PRIORITY_KEYS.indexOf(right);
                if (leftPriority !== -1 || rightPriority !== -1) {
                    if (leftPriority === -1) return 1;
                    if (rightPriority === -1) return -1;
                    return leftPriority - rightPriority;
                }
            }
            return compareKeysAscii(left, right);
        });

        const sorted = {};
        for (const key of keys) {
            sorted[key] = hasVolatile && Object.hasOwn(volatileKeys, key)
                ? visit(volatileKeys[key])
                : visit(node[key]);
        }
        return sorted;
    };

    return visit(value);
}

/**
 * Formats a request payload as 2-space indented canonical JSON with a trailing newline.
 * @param {unknown} payload
 * @param {{ volatileKeys?: Record<string, unknown> }} [options]
 * @returns {string}
 */
export function formatGoldenJson(payload, options = {}) {
    return `${JSON.stringify(canonicalizeGoldenRequest(payload, options), null, 2)}\n`;
}

/**
 * Loads and parses a committed golden fixture file.
 * @param {string} caseId
 * @param {string} [dir]
 * @returns {Record<string, any>}
 */
export function loadGoldenFixture(caseId, dir = GOLDEN_PROMPTS_DIR) {
    const filePath = getGoldenFixturePath(caseId, dir);
    if (!fs.existsSync(filePath)) {
        throw new Error(
            `Golden prompt fixture "${caseId}" does not exist at ${filePath}. `
            + `Run with ${UPDATE_GOLDEN_ENV_VAR}=1 to generate it.`,
        );
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
}

/**
 * Computes line operations between two arrays of lines using longest common subsequence.
 * @param {string[]} expectedLines
 * @param {string[]} actualLines
 * @returns {{ type: 'equal' | 'delete' | 'insert', line: string, oldLine: number, newLine: number }[]}
 */
function diffLinesLcs(expectedLines, actualLines) {
    const m = expectedLines.length;
    const n = actualLines.length;

    // Trim matching prefix and suffix so typical small diffs stay linear in memory and time.
    let prefix = 0;
    while (prefix < m && prefix < n && expectedLines[prefix] === actualLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < m - prefix
        && suffix < n - prefix
        && expectedLines[m - 1 - suffix] === actualLines[n - 1 - suffix]
    ) {
        suffix++;
    }

    const midExpected = expectedLines.slice(prefix, m - suffix);
    const midActual = actualLines.slice(prefix, n - suffix);
    const rows = midExpected.length;
    const cols = midActual.length;

    const dp = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            dp[i][j] = midExpected[i] === midActual[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const ops = [];
    for (let k = 0; k < prefix; k++) {
        ops.push({ type: 'equal', line: expectedLines[k], oldLine: k + 1, newLine: k + 1 });
    }

    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
        if (midExpected[i] === midActual[j]) {
            ops.push({ type: 'equal', line: midExpected[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            ops.push({ type: 'delete', line: midExpected[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
            i++;
        } else {
            ops.push({ type: 'insert', line: midActual[j], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
            j++;
        }
    }
    while (i < rows) {
        ops.push({ type: 'delete', line: midExpected[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        i++;
    }
    while (j < cols) {
        ops.push({ type: 'insert', line: midActual[j], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        j++;
    }

    for (let k = 0; k < suffix; k++) {
        const oldIdx = m - suffix + k;
        const newIdx = n - suffix + k;
        ops.push({ type: 'equal', line: expectedLines[oldIdx], oldLine: oldIdx + 1, newLine: newIdx + 1 });
    }

    return ops;
}

/**
 * Formats a readable unified before-and-after diff between expected and actual text.
 * @param {string} expectedText
 * @param {string} actualText
 * @param {{ expectedLabel?: string, actualLabel?: string, contextLines?: number }} [options]
 * @returns {string}
 */
export function buildUnifiedLineDiff(
    expectedText,
    actualText,
    { expectedLabel = 'expected (golden)', actualLabel = 'actual (captured)', contextLines = 3 } = {},
) {
    const normalizedExpected = String(expectedText).replace(/\r\n/g, '\n');
    const normalizedActual = String(actualText).replace(/\r\n/g, '\n');
    if (normalizedExpected === normalizedActual) {
        return '';
    }

    const expectedLines = normalizedExpected.replace(/\n$/, '').split('\n');
    const actualLines = normalizedActual.replace(/\n$/, '').split('\n');
    const ops = diffLinesLcs(expectedLines, actualLines);

    const changedIndices = [];
    ops.forEach((op, index) => {
        if (op.type !== 'equal') {
            changedIndices.push(index);
        }
    });

    const hunks = [];
    for (const index of changedIndices) {
        const start = Math.max(0, index - contextLines);
        const end = Math.min(ops.length - 1, index + contextLines);
        const last = hunks.at(-1);
        if (last && start <= last.end + 1) {
            last.end = Math.max(last.end, end);
        } else {
            hunks.push({ start, end });
        }
    }

    const output = [`--- ${expectedLabel}`, `+++ ${actualLabel}`];
    for (const hunk of hunks) {
        const slice = ops.slice(hunk.start, hunk.end + 1);
        const oldStart = slice[0]?.oldLine ?? 1;
        const newStart = slice[0]?.newLine ?? 1;
        const oldCount = slice.filter(op => op.type !== 'insert').length;
        const newCount = slice.filter(op => op.type !== 'delete').length;
        output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
        for (const op of slice) {
            const prefix = op.type === 'delete' ? '-' : op.type === 'insert' ? '+' : ' ';
            output.push(`${prefix}${op.line}`);
        }
    }

    return `${output.join('\n')}\n`;
}

/**
 * Compares a captured request payload against its committed golden fixture, or updates the fixture
 * when `UPDATE_GOLDEN_PROMPTS=1` is set.
 * @param {string} caseId
 * @param {unknown} actualPayload
 * @param {{ dir?: string, env?: NodeJS.ProcessEnv, volatileKeys?: Record<string, unknown> }} [options]
 * @returns {{ updated: boolean, matched: boolean, path: string, actualText: string, expectedText: string }}
 */
export function assertGoldenPrompt(caseId, actualPayload, { dir = GOLDEN_PROMPTS_DIR, env = process.env, volatileKeys } = {}) {
    const filePath = getGoldenFixturePath(caseId, dir);
    const actualText = formatGoldenJson(actualPayload, { volatileKeys });

    if (shouldUpdateGoldenPrompts(env)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, actualText, 'utf8');
        return { updated: true, matched: true, path: filePath, actualText, expectedText: actualText };
    }

    if (!fs.existsSync(filePath)) {
        throw new Error(
            `Missing golden prompt fixture for "${caseId}" at ${filePath}.\n`
            + `Run with ${UPDATE_GOLDEN_ENV_VAR}=1 to create it intentionally.`,
        );
    }

    const expectedText = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    if (actualText !== expectedText) {
        const diff = buildUnifiedLineDiff(expectedText, actualText, {
            expectedLabel: `golden/${caseId}.json`,
            actualLabel: `captured/${caseId}.json`,
        });
        let promptDiffSection = '';
        try {
            const expectedParsed = JSON.parse(expectedText);
            const actualParsed = JSON.parse(actualText);
            if (typeof expectedParsed?.prompt === 'string' && typeof actualParsed?.prompt === 'string' && expectedParsed.prompt !== actualParsed.prompt) {
                const promptDiff = buildUnifiedLineDiff(expectedParsed.prompt, actualParsed.prompt, {
                    expectedLabel: `golden/${caseId}.prompt`,
                    actualLabel: `captured/${caseId}.prompt`,
                });
                promptDiffSection = `\nDecoded prompt text diff:\n${promptDiff}`;
            }
        } catch {
            // Keep the raw JSON diff when parsing fails.
        }
        throw new Error(
            `Golden prompt mismatch for "${caseId}".\n`
            + `If this prompt change is intentional, run with ${UPDATE_GOLDEN_ENV_VAR}=1 and review the fixture diff.\n\n`
            + diff
            + promptDiffSection,
        );
    }

    return { updated: false, matched: true, path: filePath, actualText, expectedText };
}

/**
 * Extracts concatenated prompt text from either a Chat Completion or Text Completion request body.
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function extractPromptText(payload) {
    if (Array.isArray(payload?.messages)) {
        return payload.messages
            .map((message) => {
                if (typeof message?.content === 'string') {
                    return message.content;
                }
                if (Array.isArray(message?.content)) {
                    return message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('\n');
                }
                return '';
            })
            .join('\n\n');
    }
    if (typeof payload?.prompt === 'string') {
        return payload.prompt;
    }
    return '';
}

const VOLATILE_PATTERNS = [
    { label: 'Windows drive path', pattern: /\b[A-Za-z]:\\\\|\/[A-Za-z]:\// },
    { label: 'POSIX user home path', pattern: /\/(?:Users|home)\/[^/\s"]+/ },
    { label: 'throwaway test data directory', pattern: /sillybunny-test-data-/i },
    { label: 'random temporary chat id', pattern: /Temporary Chat: [0-9a-f]{16}/i },
    { label: 'UUID v4 token', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
    { label: 'ISO timestamp with milliseconds', pattern: /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/ },
];

/**
 * Scans serialized fixture text for volatile tokens or machine-local paths.
 * @param {string} serializedFixture
 * @returns {string[]} Human-readable descriptions of any matches found.
 */
export function findVolatileArtifacts(serializedFixture) {
    const findings = [];
    for (const { label, pattern } of VOLATILE_PATTERNS) {
        const match = String(serializedFixture).match(pattern);
        if (match) {
            findings.push(`${label}: ${match[0]}`);
        }
    }
    return findings;
}
