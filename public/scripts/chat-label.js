import { escapeRegex } from './util/escape-regex.js';

export const CHAT_LABEL_TITLE_LIMIT = 72;

const CHAT_LABEL_KEYS = Object.freeze(['title', 'label', 'name']);
const GENERIC_CHAT_LABELS = new Set(['chat', 'conversation', 'new chat', 'roleplay chat', 'untitled', 'untitled chat']);
const LABEL_PREFIX_PATTERN = /^[\s"'`*_]*(?:chat\s*)?(?:title|label|name)[\s"'`*_]*[:=-]\s*/i;
const EXPLICIT_LABEL_PATTERN = /^[\s"'`*_]*(?:chat\s*)?(?:title|label|name)[\s"'`*_]*[:=-]\s*\S/i;

function stripReasoningBlocks(value) {
    return value
        .replace(/<(?:think|reasoning|analysis)\b[^>]*>[\s\S]*?(?:<\/(?:think|reasoning|analysis)>|$)/gi, '')
        .replace(/<\/(?:think|reasoning|analysis)>/gi, '')
        .trim();
}

function stripOuterCodeFence(value) {
    const match = value.match(/^```(?:json|text)?[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?```$/i);
    return match ? match[1].trim() : value;
}

function isMachineShapedText(value) {
    const text = value.trim();
    if (!text) {
        return false;
    }

    const unprefixedText = text.replace(LABEL_PREFIX_PATTERN, '').trim();
    if (unprefixedText !== text) {
        try {
            if (typeof JSON.parse(unprefixedText) !== 'string') {
                return true;
            }
        } catch {
            if (/^(?:\[|{)\s*(?:["'{]|\[)/.test(unprefixedText)) {
                return true;
            }
        }
    }

    if (/^\[object Object\]$/i.test(text) || /^\s*(?:\[|{|")/.test(text) || /```/.test(text)) {
        return true;
    }

    if (/^\s*(?:content|message|response)\s*[:=]/i.test(text)
        || /<\/?(?:content|title|label|name)\b[^>]*>/i.test(text)
        || /"[^"\r\n]+"\s*:/i.test(text)) {
        return true;
    }

    return text.split(/\r?\n/).some(line => /^\s*(?:\[|{)/.test(line));
}

function isMachineShapedJsonString(value) {
    const text = value.trim();
    if (/^\[object Object\]$/i.test(text)
        || /^\s*(?:content|message|response)\s*[:=]/i.test(text)
        || /<\/?(?:content|title|label|name)\b[^>]*>/i.test(text)
        || /"[^"\r\n]+"\s*:/i.test(text)) {
        return true;
    }

    try {
        const nestedValue = JSON.parse(text);
        return nestedValue !== null && typeof nestedValue === 'object';
    } catch {
        return /^(?:\[|{)\s*(?:["'{]|\[)/.test(text);
    }
}

function getLabelFromJson(value, displayName) {
    if (typeof value === 'string') {
        return isMachineShapedJsonString(value) ? '' : normalizeGeneratedChatLabel(value, displayName);
    }

    if (value === null || Array.isArray(value) || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        return '';
    }

    if (Object.values(value).some(item => item !== null && typeof item === 'object')) {
        return '';
    }

    const presentKeys = CHAT_LABEL_KEYS.filter(key => Object.prototype.hasOwnProperty.call(value, key));
    if (!presentKeys.length) {
        return '';
    }

    const label = presentKeys.map(key => value[key]).find(Boolean);
    return typeof label === 'string' ? normalizeGeneratedChatLabel(label, displayName) : '';
}

export function truncateChatLabelText(value, limit = CHAT_LABEL_TITLE_LIMIT) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length <= limit) {
        return text;
    }

    const clipped = text.slice(0, limit).trim();
    const wordBoundary = clipped.lastIndexOf(' ');
    return (wordBoundary > 24 ? clipped.slice(0, wordBoundary) : clipped).replace(/[._ -]+$/g, '').trim();
}

export function normalizeGeneratedChatLabel(value, displayName = '') {
    if (typeof value !== 'string') {
        return '';
    }

    const unprefixedValue = value.replace(LABEL_PREFIX_PATTERN, '').trim();
    if (/^\[object Object\]$/i.test(unprefixedValue)) {
        return '';
    }

    let title = stripOuterCodeFence(stripReasoningBlocks(value))
        .replace(LABEL_PREFIX_PATTERN, '')
        .replace(/\.(?:jsonl?|txt)$/i, '')
        .replace(/[\\/:*?"<>|{}\u005B\u005D]+/g, ' ')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[\s"'`*_]+|[\s"'`*_]+$/g, '')
        .replace(/[._ -]+$/g, '')
        .trim();

    const normalizedDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
    if (normalizedDisplayName) {
        title = title.replace(new RegExp(`^${escapeRegex(normalizedDisplayName)}\\s*[-:]\\s*`, 'i'), '').trim();
    }

    title = truncateChatLabelText(title);
    return GENERIC_CHAT_LABELS.has(title.toLowerCase()) ? '' : title;
}

export function extractGeneratedChatLabel(responseText, displayName = '') {
    if (typeof responseText !== 'string') {
        return '';
    }

    const text = stripOuterCodeFence(stripReasoningBlocks(responseText));
    if (!text) {
        return '';
    }

    try {
        return getLabelFromJson(JSON.parse(text), displayName);
    } catch {
        if (isMachineShapedText(text)) {
            return '';
        }
    }

    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const explicitLines = lines.filter(line => EXPLICIT_LABEL_PATTERN.test(line));
    if (explicitLines.length === 1) {
        return normalizeGeneratedChatLabel(explicitLines[0], displayName);
    }

    return lines.length === 1 ? normalizeGeneratedChatLabel(lines[0], displayName) : '';
}
