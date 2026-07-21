export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024 * 1024;

const SENSITIVE_URL_PARAMETER = /^(?:api[_-]?key|key|token|access[_-]?token|auth|authorization|secret|password|passwd|signature|sig|x-amz-credential|x-amz-security-token|x-amz-signature|x-goog-api-key|x-goog-credential|x-goog-signature)$/i;
const SENSITIVE_URL_FRAGMENT = /(?:api[_-]?key|token|auth|secret|password|signature|sig)(?:=|:)/i;

const SAFE_IMAGE_MIME_TYPES = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
]);

function isPrivateNetworkHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host || host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "::" || host === "::1" || /^(?:fc|fd|fe[89ab]|ff)/i.test(host) || host.startsWith("::ffff:")) return true;

    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!ipv4) return false;
    const octets = ipv4.slice(1).map(Number);
    if (octets.some(octet => octet > 255)) return true;
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 198 && (b === 18 || b === 19));
}

export function redactUrlCredentials(value) {
    if (typeof value !== "string") return value;
    const isAbsolute = /^https?:\/\//i.test(value);
    const isProtocolRelative = value.startsWith("//");
    const isRootRelative = value.startsWith("/") && !value.startsWith("//");
    if (!isAbsolute && !isProtocolRelative && !isRootRelative) return value;
    try {
        const parsed = new URL(value, "https://redaction.invalid");
        let changed = false;
        if (parsed.username || parsed.password) {
            parsed.username = "";
            parsed.password = "";
            changed = true;
        }
        for (const key of [...parsed.searchParams.keys()]) {
            if (SENSITIVE_URL_PARAMETER.test(key)) {
                parsed.searchParams.delete(key);
                changed = true;
            }
        }
        if (parsed.hash && SENSITIVE_URL_FRAGMENT.test(parsed.hash)) {
            parsed.hash = "";
            changed = true;
        }
        if (!changed) return value;
        if (isAbsolute) return parsed.href;
        if (isProtocolRelative) return `//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return value;
    }
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

    const dataMatch = source.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i);
    if (dataMatch) {
        const mime = dataMatch[1].toLowerCase();
        if (!SAFE_IMAGE_MIME_TYPES.has(mime)) return null;
        const estimatedBytes = Math.floor(dataMatch[2].length * 3 / 4);
        return estimatedBytes <= maxInlineBytes ? source : null;
    }
    if (source.startsWith("data:")) return null;
    if (/[\u0000-\u0020"'<>`]/.test(source)) return null;

    try {
        const parsed = new URL(source, baseUrl);
        const isRelative = !/^[A-Za-z][A-Za-z\d+.-]*:/.test(source);
        if (isRelative && !allowRelative) return null;
        if (parsed.protocol === "blob:") return parsed.href;
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

    if (!response.body?.getReader) {
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) throw new Error("Image response is too large");
        return buffer;
    }

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
