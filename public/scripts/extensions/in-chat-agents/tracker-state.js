import { escapeRegex } from '../../util/escape-regex.js';

function normalizeText(value = '') {
    return String(value ?? '').replaceAll(/\r\n?/g, '\n');
}

export const TRACKER_REPAIR_INSTRUCTION = 'Repair mode: produce the requested result again in the requested format. Keep scene prose, character dialogue, and narrative continuation outside the result. For choice/menu agents, return the bracketed choice or direction block.';

function getTrackerTagFromPattern(pattern = '') {
    return String(pattern).match(/\\+\[([A-Za-z][A-Za-z0-9_-]*)/)?.[1] ?? '';
}

function getTrackerTagFromText(text = '') {
    return String(text).match(/\[([A-Za-z][A-Za-z0-9_-]*)(?=[:|\]])/)?.[1] ?? '';
}

function getTrackerTag(agent = {}, text = '') {
    const pattern = String(agent?.postProcess?.extractPattern ?? '').trim();
    if (pattern) return getTrackerTagFromPattern(pattern);
    return getTrackerTagFromText(agent?.prompt) || getTrackerTagFromText(text);
}

/**
 * Finds complete and malformed blocks for one tracker tag. Variant openers such
 * as [NPC:MAJOR|...] share the base tag's [/NPC] closer.
 * @param {string} text
 * @param {string} tag
 * @returns {Array<{ complete: boolean, replaceable: boolean, start: number, end: number, text: string }>}
 */
export function findTrackerBlocks(text, tag) {
    const source = normalizeText(text);
    if (!tag) return [];

    const escapedTag = escapeRegex(String(tag));
    const opener = new RegExp(`\\[${escapedTag}(?=[:|\\]])`, 'ig');
    const closer = new RegExp(`\\[\\/${escapedTag}\\]`, 'ig');
    const openers = [...source.matchAll(opener)];
    const blocks = [];
    const matchedClosers = new Set();

    for (let index = 0; index < openers.length; index++) {
        const openMatch = openers[index];
        const nextOpenStart = openers[index + 1]?.index ?? source.length;
        const lineEnd = source.indexOf('\n', openMatch.index);
        const openingBracketEnd = source.indexOf(']', openMatch.index + openMatch[0].length);
        const hasCompleteOpener = openingBracketEnd >= 0 && (lineEnd < 0 || openingBracketEnd < lineEnd);
        closer.lastIndex = hasCompleteOpener ? openingBracketEnd + 1 : nextOpenStart;
        const closeMatch = hasCompleteOpener ? closer.exec(source) : null;

        if (closeMatch && closeMatch.index < nextOpenStart) {
            const end = closeMatch.index + closeMatch[0].length;
            matchedClosers.add(closeMatch.index);
            blocks.push({
                complete: true,
                replaceable: true,
                start: openMatch.index,
                end,
                text: source.slice(openMatch.index, end),
            });
            continue;
        }

        const isTrailingBlock = nextOpenStart === source.length;
        const malformedEnd = isTrailingBlock
            ? source.length
            : hasCompleteOpener
                ? openingBracketEnd + 1
                : Math.min(lineEnd < 0 ? source.length : lineEnd, nextOpenStart);
        blocks.push({
            complete: false,
            replaceable: false,
            start: openMatch.index,
            end: malformedEnd,
            text: source.slice(openMatch.index, malformedEnd),
        });
    }

    const unmatchedClosers = [...source.matchAll(new RegExp(`\\[\\/${escapedTag}\\]`, 'ig'))]
        .filter(match => !matchedClosers.has(match.index))
        .map(match => ({
            complete: false,
            replaceable: false,
            start: match.index,
            end: match.index + match[0].length,
            text: match[0],
        }));

    return [...blocks, ...unmatchedClosers].sort((left, right) => left.start - right.start);
}

function compileExtractPattern(pattern) {
    if (!pattern) return { regex: null, error: '' };

    try {
        return { regex: new RegExp(pattern, 'g'), error: '' };
    } catch (error) {
        return {
            regex: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function getTrackerMetadataKey(agent = {}) {
    const variable = String(agent?.postProcess?.extractVariable ?? '').trim();
    return variable ? `agent_${variable}` : '';
}

/**
 * Inspects tracker text using structural block boundaries first. The configured
 * extractor remains useful metadata, but a stale or invalid regex cannot make a
 * complete [TAG]...[/TAG] block look broken.
 * @param {object} agent
 * @param {string} text
 */
export function inspectTrackerState(agent = {}, text = '') {
    const pattern = String(agent?.postProcess?.extractPattern ?? '').trim();
    const source = normalizeText(text);
    const patternTag = getTrackerTagFromPattern(pattern);
    const tag = getTrackerTag(agent, source);
    const { regex, error } = compileExtractPattern(pattern);
    const matches = regex ? [...source.matchAll(regex)].map(match => String(match[0] ?? '')).filter(Boolean) : [];
    const blocks = findTrackerBlocks(source, tag);
    const completeBlocks = blocks.filter(block => block.complete);
    const malformedBlocks = blocks.filter(block => !block.complete);
    const structuralPayloads = completeBlocks.map(block => block.text.trim()).filter(Boolean);
    const regexPayloads = matches.map(match => match.trim()).filter(Boolean);

    if (structuralPayloads.length > 0 && malformedBlocks.length === 0) {
        return {
            status: 'valid',
            matches,
            payloads: structuralPayloads,
            value: structuralPayloads.join('\n\n'),
            tag,
            error,
            blocks,
        };
    }

    // Custom trackers may use a non-bracket grammar. Keep their configured
    // extractor authoritative when it does not describe a structural tag.
    if (!patternTag && blocks.length === 0 && regexPayloads.length > 0) {
        return {
            status: 'valid',
            matches,
            payloads: regexPayloads,
            value: regexPayloads.join('\n'),
            tag: '',
            error,
            blocks,
        };
    }

    const status = blocks.length > 0
        ? 'malformed'
        : error
            ? 'invalid-pattern'
            : 'missing';

    return {
        status,
        matches,
        payloads: [],
        value: '',
        tag,
        error,
        blocks,
    };
}

export function getTrackerRepairPayload(agent = {}, text = '') {
    const inspection = inspectTrackerState(agent, text);
    return {
        ...inspection,
        payload: inspection.status === 'valid' ? inspection.value : '',
    };
}

/**
 * Companion cards are sidecar tracker output rather than story prose. Repair a
 * single card-local missing or mistyped closer before asking the model again.
 * Inline message repair intentionally continues to reject malformed spans.
 * @param {object} agent
 * @param {string} text
 */
export function normalizeCompanionTrackerRepairPayload(agent = {}, text = '') {
    const source = normalizeText(text);
    const inspection = getTrackerRepairPayload(agent, source);
    if (inspection.payload) {
        return inspection;
    }

    const malformedBlocks = inspection.blocks.filter(block => !block.complete);
    const firstContentIndex = source.search(/\S/u);
    if (!inspection.tag || malformedBlocks.length !== 1 || inspection.blocks.length !== 1 || malformedBlocks[0].start !== firstContentIndex) {
        return inspection;
    }

    const escapedTag = escapeRegex(String(inspection.tag));
    const malformedCloser = new RegExp(`(?:\\r?\\n)?\\s*\\/?${escapedTag}\\]\\s*$`, 'i');
    let normalized = source.trim();
    if (malformedCloser.test(normalized)) {
        normalized = normalized.replace(malformedCloser, `\n[/${inspection.tag}]`);
    }
    if (!new RegExp(`\\[\\/${escapedTag}\\]\\s*$`, 'i').test(normalized)) {
        normalized = `${normalized}\n[/${inspection.tag}]`;
    }

    return getTrackerRepairPayload(agent, normalized);
}

/**
 * Atomically replaces an agent's existing complete blocks, repairs a safely
 * bounded trailing malformed block, or inserts a missing tracker payload.
 * @param {object} agent
 * @param {string} messageText
 * @param {string} payload
 * @param {{ prepend?: boolean }} options
 */
export function mergeTrackerRepairPayload(agent = {}, messageText = '', payload = '', { prepend = false } = {}) {
    const source = normalizeText(messageText);
    const addition = getTrackerRepairPayload(agent, payload).payload;
    if (!addition) {
        return { text: source, changed: false, replaced: false, reason: 'invalid-payload' };
    }

    const inspection = inspectTrackerState(agent, source);
    const completeBlocks = inspection.blocks.filter(block => block.complete);
    if (inspection.status === 'valid' && completeBlocks.length > 0) {
        let nextText = source;
        for (let index = completeBlocks.length - 1; index >= 0; index--) {
            const block = completeBlocks[index];
            nextText = `${nextText.slice(0, block.start)}${index === 0 ? addition : ''}${nextText.slice(block.end)}`;
        }
        return {
            text: nextText,
            changed: nextText !== source,
            replaced: true,
            reason: '',
        };
    }

    const malformedBlocks = inspection.blocks.filter(block => !block.complete);
    if (malformedBlocks.length > 0) {
        const block = completeBlocks.length === 0 && malformedBlocks.length === 1 ? malformedBlocks[0] : null;
        if (!block?.replaceable) {
            return { text: source, changed: false, replaced: false, reason: 'unsafe-malformed' };
        }

        const nextText = `${source.slice(0, block.start)}${addition}${source.slice(block.end)}`;
        return {
            text: nextText,
            changed: nextText !== source,
            replaced: true,
            reason: '',
        };
    }

    if (!source.trim()) {
        return { text: addition, changed: true, replaced: false, reason: '' };
    }

    const nextText = prepend
        ? `${addition}\n\n${source}`
        : `${source}${source.endsWith('\n') ? '\n' : '\n\n'}${addition}`;
    return {
        text: nextText,
        changed: nextText !== source,
        replaced: false,
        reason: '',
    };
}
