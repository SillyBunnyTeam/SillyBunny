import { isCredentialFieldName } from "./security.js";

export const DEFAULT_LOG_MAX_ENTRIES = 100;
export const DEFAULT_LOG_MAX_BYTES = 64 * 1024;
export const DEFAULT_LOG_MAX_ENTRY_BYTES = 4 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_SUFFIX = "... [truncated]";

export function utf8ByteLength(value) {
    return encoder.encode(String(value ?? "")).byteLength;
}

function decodeUtf8Prefix(bytes, maxBytes) {
    for (let end = Math.min(bytes.byteLength, maxBytes); end >= Math.max(0, maxBytes - 3); end--) {
        try {
            return fatalDecoder.decode(bytes.subarray(0, end));
        } catch {
            // A UTF-8 code point can span at most four bytes.
        }
    }
    return decoder.decode(bytes.subarray(0, Math.max(0, maxBytes)));
}

export function truncateLogEntry(value, maxBytes) {
    const text = String(value ?? "");
    const limit = Math.max(0, Math.trunc(Number(maxBytes) || 0));
    const bytes = encoder.encode(text);
    if (bytes.byteLength <= limit) return text;
    if (!limit) return "";

    const suffixBytes = encoder.encode(TRUNCATION_SUFFIX);
    if (suffixBytes.byteLength >= limit) return decodeUtf8Prefix(bytes, limit);
    return `${decodeUtf8Prefix(bytes, limit - suffixBytes.byteLength)}${TRUNCATION_SUFFIX}`;
}

function redactUrlToken(value) {
    const trailing = value.match(/[),.;!?]+$/)?.[0] || "";
    return `[URL redacted]${trailing}`;
}

export function redactLogMessage(value) {
    let text = String(value ?? "");

    text = text.replace(/\b(?:https?|wss?):\/\/[^\s<>"'`]+|(?:blob|data):[^\s<>"'`]+/gi, redactUrlToken);
    text = text.replace(/(^|[\s([=])(\/\/[A-Za-z0-9][^\s<>"'`]*)/gi, (_match, prefix, url) => `${prefix}${redactUrlToken(url)}`);
    text = text.replace(/([?&#;][^\s=&#;]{1,128}\s*[=:]\s*)([^&#;\s]*)/g, "$1[redacted]");
    text = text.replace(/\b(authorization|proxy-authorization|cookie|set-cookie)(\s*[:=]\s*)[^\r\n]+/gi, "$1$2[redacted]");
    text = text.replace(/(["']?)([A-Za-z][A-Za-z0-9_.-]{1,63})\1(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/g,
        (match, quote, key, separator) => isCredentialFieldName(key)
            ? `${quote}${key}${quote}${separator}[redacted]`
            : match);

    return text;
}

export class PrivacyLogBuffer {
    constructor({
        maxEntries = DEFAULT_LOG_MAX_ENTRIES,
        maxBytes = DEFAULT_LOG_MAX_BYTES,
        maxEntryBytes = DEFAULT_LOG_MAX_ENTRY_BYTES,
        formatTimestamp = () => new Date().toLocaleTimeString(),
    } = {}) {
        this.maxEntries = Math.max(1, Math.trunc(maxEntries));
        this.maxBytes = Math.max(1, Math.trunc(maxBytes));
        this.maxEntryBytes = Math.min(this.maxBytes, Math.max(1, Math.trunc(maxEntryBytes)));
        this.formatTimestamp = formatTimestamp;
        this.items = [];
        this.totalBytes = 0;
    }

    append(message, { diagnostic = false, debugEnabled = false } = {}) {
        if (diagnostic && debugEnabled !== true) return null;
        // Bound the raw input BEFORE redaction so hostile provider payloads cannot
        // drive megabytes of regex work; the bounded value is also what callers print.
        const boundedInput = truncateLogEntry(message, this.maxEntryBytes * 8);
        const redactedMessage = redactLogMessage(boundedInput);
        const timestamp = String(this.formatTimestamp?.() ?? "");
        const prefix = timestamp ? `[${timestamp}] ` : "";
        const entry = truncateLogEntry(`${prefix}${redactedMessage}`, this.maxEntryBytes);
        const bytes = utf8ByteLength(entry);

        this.items.push({ entry, bytes });
        this.totalBytes += bytes;
        while (this.items.length > this.maxEntries || this.totalBytes > this.maxBytes) {
            const removed = this.items.shift();
            this.totalBytes -= removed?.bytes || 0;
        }

        return { entry, message: redactedMessage };
    }

    clear() {
        this.items.length = 0;
        this.totalBytes = 0;
    }

    get entries() {
        return this.items.map(item => item.entry);
    }
}
