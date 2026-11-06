import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_BASE_URLS = {
    openai: 'https://api.linkapi.ai/v1',
    gemini: 'https://api.linkapi.ai',
};

const KEY_NAMES = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };
const BASE_URL_NAMES = { openai: 'OPENAI_BASE_URL', gemini: 'GEMINI_BASE_URL' };
const ALLOWED_NAMES = new Set([...Object.values(KEY_NAMES), ...Object.values(BASE_URL_NAMES)]);

/** Reads NAME=value lines, keeping only the four names this tool uses. */
function parseDotenv(text) {
    const values = {};
    for (const line of text.split('\n')) {
        const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match && ALLOWED_NAMES.has(match[1])) {
            values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
    }
    return values;
}

function parseBaseUrl(name, value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${name} is not a valid URL.`);
    }
    const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
        throw new Error(`${name} must use https so the key is not sent in clear text.`);
    }
    if (url.username || url.password || url.search) {
        throw new Error(`${name} must not carry credentials or a query string.`);
    }
    return value;
}

/**
 * Environment values win over `.env`. Nothing else in either source is read.
 * @param {{ env?: Record<string, string | undefined>, dotenvPath?: string }} sources
 */
export function loadEnvironment({ env = process.env, dotenvPath } = {}) {
    const fromFile = dotenvPath && existsSync(dotenvPath) ? parseDotenv(readFileSync(dotenvPath, 'utf8')) : {};
    const read = (name) => env[name] || fromFile[name] || undefined;
    const settings = {};
    for (const provider of Object.keys(KEY_NAMES)) {
        const baseUrlName = BASE_URL_NAMES[provider];
        settings[provider] = {
            apiKey: read(KEY_NAMES[provider]),
            baseUrl: parseBaseUrl(baseUrlName, read(baseUrlName) ?? DEFAULT_BASE_URLS[provider]),
        };
    }
    return settings;
}

/** @param {{ apiKey?: string }} providerSettings @param {'openai' | 'gemini'} provider */
export function requireKey(providerSettings, provider) {
    if (!providerSettings.apiKey) {
        throw new Error(`${KEY_NAMES[provider]} is not set. Export it or add it to assets-src/branding/.env.`);
    }
    return providerSettings.apiKey;
}
