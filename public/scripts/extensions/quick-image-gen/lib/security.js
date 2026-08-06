export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;

const PRIVATE_HOST_SUFFIX = /(?:^|\.)(?:corp|home|internal|intranet|lan|local|localdomain|home\.arpa)$/i;

const CREDENTIAL_FIELD_NAMES = new Set([
    "apikey", "key", "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "bearertoken",
    "auth", "authentication", "authorization", "secret", "clientsecret", "privatekey", "password", "passwd",
    "passphrase", "signature", "sig", "session", "sessionid", "sessionkey", "sessiontoken", "credential",
    "credentials", "awsaccesskeyid", "xamzcredential", "xamzsecuritytoken", "xamzsignature", "xgoogapikey",
    "xgoogcredential", "xgoogsignature",
]);
const CREDENTIAL_FIELD_SUFFIXES = new Set([
    "key", "token", "secret", "password", "passwd", "passphrase", "credential", "credentials", "signature", "sig",
]);
const CREDENTIAL_FIELD_TOKENS = new Set([
    "auth", "authentication", "authorization", "credential", "credentials", "key", "passphrase", "passwd", "password",
    "secret", "session", "sig", "signature", "token",
]);

const SAFE_IMAGE_MIME_TYPES = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/tiff",
    "image/webp",
]);

function isPrivateNetworkHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host || (!host.includes(".") && !host.includes(":"))) return true;
    if (host === "localhost" || host.endsWith(".localhost") || PRIVATE_HOST_SUFFIX.test(host)) return true;
    if (host === "::" || host === "::1" || host.startsWith("::") || /^(?:fc|fd|fe[89a-f]|ff)/i.test(host) || host.startsWith("::ffff:")) return true;

    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4) return false;
    const octets = ipv4.slice(1).map(Number);
    if (octets.some(octet => octet > 255)) return true;
    const [a, b, c] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0 && (c === 0 || c === 2))
        || (a === 192 && b === 168)
        || (a === 192 && b === 88 && c === 99)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113);
}

function safeDecodeUrlComponent(value) {
    let decoded = value.replace(/\+/g, " ");
    for (let pass = 0; pass < 2; pass++) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            break;
        }
    }
    return decoded;
}

function credentialFieldTokens(value) {
    return String(value || "")
        .trim()
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

export function isCredentialFieldName(value) {
    const tokens = credentialFieldTokens(safeDecodeUrlComponent(String(value || "")));
    if (!tokens.length) return false;
    const compact = tokens.join("");
    return CREDENTIAL_FIELD_NAMES.has(compact)
        || tokens.some(token => CREDENTIAL_FIELD_TOKENS.has(token))
        || (tokens.length > 1 && CREDENTIAL_FIELD_SUFFIXES.has(tokens.at(-1)));
}

function splitParameter(part) {
    const match = String(part).match(/^([^=:]*)([=:]?)([\s\S]*)$/);
    return { key: safeDecodeUrlComponent(match?.[1] || ""), separator: match?.[2] || "", value: match?.[3] || "" };
}

function stripSensitiveParameters(value) {
    if (!value) return { value: "", changed: false };
    let changed = false;
    const kept = value.split(/[&;]/).filter((part) => {
        const { key, separator } = splitParameter(part);
        if (!separator || !isCredentialFieldName(key)) return true;
        changed = true;
        return false;
    });
    return { value: kept.join("&"), changed };
}

function redactUrlLikeString(value) {
    let result = value.trim();
    let changed = false;
    const withoutUserInfo = result.replace(/^([A-Za-z][A-Za-z\d+.-]*:\/\/|\/\/)[^/?#\s]*@/i, "$1");
    if (withoutUserInfo !== result) {
        result = withoutUserInfo;
        changed = true;
    }

    const hashIndex = result.indexOf("#");
    let hash = hashIndex >= 0 ? result.slice(hashIndex + 1) : "";
    let beforeHash = hashIndex >= 0 ? result.slice(0, hashIndex) : result;
    if (hash) {
        const sanitized = stripSensitiveParameters(hash);
        if (sanitized.changed) changed = true;
        hash = sanitized.value;
    }

    const queryIndex = beforeHash.indexOf("?");
    if (queryIndex >= 0) {
        const base = beforeHash.slice(0, queryIndex);
        const sanitized = stripSensitiveParameters(beforeHash.slice(queryIndex + 1));
        if (sanitized.changed) changed = true;
        beforeHash = `${base}${sanitized.value ? `?${sanitized.value}` : ""}`;
    }

    const resultValue = `${beforeHash}${hash ? `#${hash}` : ""}`;
    return { value: changed ? resultValue : result, changed };
}

function containsCredentialAssignment(value) {
    const source = String(value || "");
    const authority = source.match(/^(?:[A-Za-z][A-Za-z\d+.-]*:\/\/|\/\/)([^/?#\s]*)/i)?.[1] || "";
    if (safeDecodeUrlComponent(authority).includes("@")) return true;
    const malformedAuthority = source.split(/[?#]/, 1)[0];
    if (malformedAuthority.includes("@") && /^[A-Za-z][A-Za-z\d+.-]*:\/?/.test(malformedAuthority)) return true;
    for (const candidate of new Set([source, safeDecodeUrlComponent(source)])) {
        for (const match of candidate.matchAll(/(?:^|[/?&#;\s])([^=/?&#;:\s]+)\s*([=:])/g)) {
            if (isCredentialFieldName(match[1])) return true;
        }
    }
    return false;
}

export function redactUrlCredentials(value) {
    if (typeof value !== "string") return value;
    const source = value.trim();
    const looksLikeUrl = /^(?:[A-Za-z][A-Za-z\d+.-]*:\/\/|\/\/)/.test(source)
        || source.includes("?") || source.includes("#");
    const sanitized = redactUrlLikeString(source);
    if (containsCredentialAssignment(sanitized.value)) return undefined;
    if (!sanitized.changed && containsCredentialAssignment(source)) return undefined;
    return looksLikeUrl ? sanitized.value : value;
}

export function sanitizeReproducibleModel(value, provider = "") {
    if (String(provider || "").toLowerCase() === "custom" || typeof value !== "string") return undefined;
    if (/[\u0000-\u001f\u007f]/.test(value) || /^\s*(?:basic|bearer|token)\s+\S/i.test(value)) return undefined;
    return redactUrlCredentials(value);
}

export function normalizeImageSource(value, {
    baseUrl = globalThis.location?.href || "http://localhost/",
    allowHttp = true,
    allowRelative = true,
    blockPrivateHosts = false,
    maxInlineBytes = MAX_INLINE_IMAGE_BYTES,
} = {}) {
    if (typeof value !== "string") return null;
    const source = value.trim();
    if (!source) return null;

    if (source.startsWith("data:")) {
        const dataMatch = source.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
        if (dataMatch) {
            let mime = dataMatch[1].toLowerCase().trim();
            if (mime === "image/jpg") mime = "image/jpeg";
            if (!SAFE_IMAGE_MIME_TYPES.has(mime)) return null;
            const cleanB64 = dataMatch[2].replace(/[\s\r\n]/g, "").replace(/-/g, "+").replace(/_/g, "/");
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanB64)) return null;
            const estimatedBytes = Math.floor(cleanB64.length * 3 / 4);
            if (estimatedBytes > maxInlineBytes) return null;
            return `data:${mime};base64,${cleanB64}`;
        }
        return null;
    }
    if (/[\u0000-\u0020"'<>`]/.test(source)) return null;

    try {
        const parsed = new URL(source, baseUrl);
        const isRelative = !/^[A-Za-z][A-Za-z\d+.-]*:/.test(source);
        if (isRelative && !allowRelative) return null;
        if (parsed.protocol === "blob:") return parsed.href;
        if (parsed.username || parsed.password) return null;
        if (blockPrivateHosts && isPrivateNetworkHost(parsed.hostname)) return null;
        if (parsed.protocol === "https:") return parsed.href;
        if (parsed.protocol === "http:" && allowHttp) return parsed.href;
    } catch {
        return null;
    }
    return null;
}

export async function readResponseArrayBuffer(response, maxBytes = MAX_IMAGE_BYTES) {
    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel?.("Response exceeds the configured size limit").catch(() => {});
        throw new Error(`Image exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit`);
    }

    if (!response.body?.getReader) throw new Error("Response body streaming is unavailable; size limit cannot be enforced");

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel("Image response is too large");
                throw new Error("Image response is too large");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result.buffer;
}

export async function readResponseText(response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
    return new TextDecoder().decode(await readResponseArrayBuffer(response, maxBytes));
}

export async function readResponseJson(response, maxBytes = MAX_PROVIDER_RESPONSE_BYTES) {
    const text = await readResponseText(response, maxBytes);
    return JSON.parse(text);
}

export function replaceSelectOptions(select, options, selectedValue = "") {
    select.replaceChildren();
    for (const optionData of options) {
        const option = select.ownerDocument.createElement("option");
        option.value = String(optionData.value ?? "");
        option.textContent = String(optionData.label ?? optionData.value ?? "");
        option.disabled = !!optionData.disabled;
        option.selected = String(optionData.value ?? "") === String(selectedValue ?? "");
        select.appendChild(option);
    }
}
