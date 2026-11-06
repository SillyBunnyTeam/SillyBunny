import { decodeBase64Image, downloadImage } from './images.mjs';
import { redactHeaders, redactText } from './redact.mjs';

const REQUEST_TIMEOUT_MS = 300_000;
const OPENAI_QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const OPENAI_BACKGROUNDS = ['transparent', 'opaque', 'auto'];
const GEMINI_SIZES = ['512', '1K', '2K', '4K'];
const GEMINI_ASPECTS = ['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/**
 * A request description that holds the real credential. Only `describePlan` output may be shown or logged.
 * @typedef {{ method: string, url: string, headers: Record<string, string>, kind: 'json' | 'multipart',
 *   fields: Record<string, any>, files: Array<{ field: string, filename: string, mime: string, bytes: Buffer }> }} RequestPlan
 */

/**
 * @typedef {{ model: string, prompt: string, refs: Array<{ bytes: Buffer, mime: string, filename: string }>,
 *   size: string, n: number, aspect?: string, quality?: string, background?: string }} Job
 */

const joinUrl = (base, path) => `${base.replace(/\/+$/, '')}${path}`;

/** @param {RequestPlan} plan */
function toFetchInit(plan) {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (plan.kind === 'json') {
        return { method: plan.method, headers: { ...plan.headers, 'content-type': 'application/json' }, body: JSON.stringify(plan.fields), signal };
    }
    const form = new FormData();
    for (const [name, value] of Object.entries(plan.fields)) {
        form.append(name, String(value));
    }
    for (const file of plan.files) {
        form.append(file.field, new Blob([file.bytes], { type: file.mime }), file.filename);
    }
    return { method: plan.method, headers: plan.headers, body: form, signal };
}

/**
 * The only safe view of a request: credentials redacted, long strings and image bytes elided.
 * @param {RequestPlan} plan
 */
export function describePlan(plan) {
    const elide = (value) => {
        const looksLikeBase64 = typeof value === 'string' && value.length > 60 && /^[A-Za-z0-9+/=]+$/.test(value);
        if (typeof value === 'string' && (value.length > 200 || looksLikeBase64)) {
            return `<${value.length} chars>`;
        }
        if (Array.isArray(value)) {
            return value.map(elide);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elide(v)]));
        }
        return value;
    };
    return {
        method: plan.method,
        url: plan.url,
        headers: redactHeaders(plan.headers),
        kind: plan.kind,
        fields: elide(plan.fields),
        files: plan.files.map(({ field, filename, mime, bytes }) => ({ field, filename, mime, bytes: bytes.length })),
    };
}

function describeCause(error) {
    const cause = error.cause ? ` (${error.cause.message ?? error.cause})` : '';
    return `${error.message}${cause}`;
}

/** The relay reports a failed upstream channel as `{ error: { type: "upstream_error" } }` and does not charge for it. */
function isUpstreamError(text) {
    try {
        return JSON.parse(text)?.error?.type === 'upstream_error';
    } catch {
        return false;
    }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends a plan and returns parsed JSON. Every failure message is redacted before it leaves this function.
 * A non-2xx `upstream_error` is retried once. A thrown fetch (timeout, dropped connection) is never retried,
 * because the relay may already have started, and charged for, the job.
 */
async function sendPlan(plan, { fetchImpl, secrets, retry }) {
    for (let attempt = 0; ; attempt++) {
        let response;
        try {
            response = await fetchImpl(plan.url, toFetchInit(plan));
        } catch (error) {
            throw new Error(`request failed: ${redactText(describeCause(error), secrets)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            if (attempt === 0 && isUpstreamError(text)) {
                retry.onRetry(`relay upstream_error (HTTP ${response.status}); retrying once in ${retry.delayMs} ms`);
                await retry.sleep(retry.delayMs);
                continue;
            }
            throw new Error(`HTTP ${response.status}: ${redactText(text.slice(0, 500), secrets)}`);
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`response was not JSON: ${redactText(text.slice(0, 200), secrets)}`);
        }
    }
}

function assertCount(job, { maxRefs, maxN }) {
    if (!Number.isInteger(job.n) || job.n < 1 || job.n > maxN) {
        throw new Error(`n must be an integer from 1 to ${maxN}.`);
    }
    if (job.refs.length > maxRefs) {
        throw new Error(`This provider takes at most ${maxRefs} reference images; got ${job.refs.length}.`);
    }
}

function assertOpenAiSize(size) {
    if (size === 'auto') {
        return;
    }
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) {
        throw new Error(`OpenAI size must be "auto" or WIDTHxHEIGHT, got "${size}".`);
    }
    const [width, height] = [Number(match[1]), Number(match[2])];
    if (width % 16 || height % 16) {
        throw new Error(`OpenAI size ${size}: width and height must each be a multiple of 16.`);
    }
    if (Math.max(width, height) > 3840) {
        throw new Error(`OpenAI size ${size}: neither edge may exceed 3840.`);
    }
    if (Math.max(width, height) / Math.min(width, height) > 3) {
        throw new Error(`OpenAI size ${size}: aspect ratio must be between 1:3 and 3:1.`);
    }
    if (width * height < 655_360 || width * height > 8_294_400) {
        throw new Error(`OpenAI size ${size}: total pixels must be between 655360 and 8294400.`);
    }
}

function createOpenAiProvider({ apiKey, baseUrl, fetchImpl, retry }) {
    const secrets = [apiKey];
    return {
        name: 'openai',

        /** @param {Job} job */
        validate(job) {
            assertCount(job, { maxRefs: 16, maxN: 100 });
            assertOpenAiSize(job.size);
            if (job.aspect) {
                throw new Error('--aspect is a Gemini option; for OpenAI put the shape in --size.');
            }
            if (job.quality && !OPENAI_QUALITIES.includes(job.quality)) {
                throw new Error(`quality must be one of ${OPENAI_QUALITIES.join(', ')}.`);
            }
            if (job.background && !OPENAI_BACKGROUNDS.includes(job.background)) {
                throw new Error(`background must be one of ${OPENAI_BACKGROUNDS.join(', ')}.`);
            }
        },

        /**
         * Text only goes to /images/generations as JSON. References need /images/edits as multipart image[] parts.
         * One request always asks for one image: the relay has returned fewer images than `n` and still charged for `n`.
         * @param {Job} job
         * @returns {RequestPlan}
         */
        plan(job) {
            const fields = { model: job.model, prompt: job.prompt, n: 1, size: job.size };
            if (job.quality) {
                fields.quality = job.quality;
            }
            if (job.background) {
                fields.background = job.background;
            }
            const headers = { Authorization: `Bearer ${apiKey}` };
            if (job.refs.length === 0) {
                return { method: 'POST', url: joinUrl(baseUrl, '/images/generations'), headers, kind: 'json', fields, files: [] };
            }
            const files = job.refs.map((ref) => ({ field: 'image[]', filename: ref.filename, mime: ref.mime, bytes: ref.bytes }));
            return { method: 'POST', url: joinUrl(baseUrl, '/images/edits'), headers, kind: 'multipart', fields, files };
        },

        /** Sequential on purpose: the first failure stops the batch so a bad token is not retried n times. */
        async generate(job) {
            const images = [];
            const usage = [];
            let error;
            for (let i = 0; i < job.n && !error; i++) {
                try {
                    const body = await sendPlan(this.plan(job), { fetchImpl, secrets, retry });
                    const before = images.length;
                    for (const item of body.data ?? []) {
                        const bytes = item.b64_json ? decodeBase64Image(item.b64_json) : await downloadImage(item.url, fetchImpl);
                        images.push({ bytes });
                    }
                    if (images.length === before) {
                        throw new Error(`response held no images: ${JSON.stringify(body).slice(0, 300)}`);
                    }
                    if (body.usage) {
                        usage.push(body.usage);
                    }
                } catch (cause) {
                    error = redactText(cause.message, secrets);
                }
            }
            return { images, usage, error };
        },
    };
}

function createGeminiProvider({ apiKey, baseUrl, fetchImpl, retry }) {
    const secrets = [apiKey];

    /** Pulls inline images, file URLs and any text out of one generateContent response. */
    async function readImages(body) {
        const candidate = body.candidates?.[0];
        const images = [];
        const notes = [];
        for (const part of candidate?.content?.parts ?? []) {
            const inline = part.inlineData ?? part.inline_data;
            const fileUri = (part.fileData ?? part.file_data)?.fileUri ?? (part.fileData ?? part.file_data)?.file_uri;
            if (inline?.data) {
                images.push({ bytes: decodeBase64Image(inline.data) });
            } else if (fileUri) {
                images.push({ bytes: await downloadImage(fileUri, fetchImpl) });
            } else if (part.text) {
                notes.push(part.text.slice(0, 200));
            }
        }
        if (images.length === 0) {
            const reasons = [`finishReason=${candidate?.finishReason ?? 'none'}`, `blockReason=${body.promptFeedback?.blockReason ?? 'none'}`];
            throw new Error(`response held no image (${reasons.join(', ')}${notes.length ? `, text="${notes.join(' ')}"` : ''})`);
        }
        return images;
    }

    return {
        name: 'gemini',

        /** @param {Job} job */
        validate(job) {
            assertCount(job, { maxRefs: 14, maxN: 100 });
            if (!GEMINI_SIZES.includes(job.size)) {
                throw new Error(`Gemini size must be one of ${GEMINI_SIZES.join(', ')}, got "${job.size}".`);
            }
            if (job.aspect && !GEMINI_ASPECTS.includes(job.aspect)) {
                throw new Error(`Gemini aspect "${job.aspect}" is not one of ${GEMINI_ASPECTS.join(', ')}.`);
            }
            for (const option of ['quality', 'background']) {
                if (job[option]) {
                    throw new Error(`--${option} is an OpenAI option and Gemini does not take it.`);
                }
            }
        },

        /**
         * One generateContent call makes one image, so this plan ignores `n`.
         * @param {Job} job
         * @returns {RequestPlan}
         */
        plan(job) {
            const imageConfig = { imageSize: job.size };
            if (job.aspect) {
                imageConfig.aspectRatio = job.aspect;
            }
            const parts = [
                { text: job.prompt },
                ...job.refs.map((ref) => ({ inlineData: { mimeType: ref.mime, data: ref.bytes.toString('base64') } })),
            ];
            return {
                method: 'POST',
                url: joinUrl(baseUrl, `/v1beta/models/${encodeURIComponent(job.model)}:generateContent`),
                headers: { 'x-goog-api-key': apiKey },
                kind: 'json',
                fields: {
                    contents: [{ role: 'user', parts }],
                    generationConfig: { responseModalities: ['IMAGE'], imageConfig },
                },
                files: [],
            };
        },

        /** Sequential on purpose: the first failure stops the batch so a bad token is not retried n times. */
        async generate(job) {
            const images = [];
            const usage = [];
            let error;
            for (let i = 0; i < job.n; i++) {
                try {
                    const body = await sendPlan(this.plan(job), { fetchImpl, secrets, retry });
                    images.push(...await readImages(body));
                    if (body.usageMetadata) {
                        usage.push(body.usageMetadata);
                    }
                } catch (cause) {
                    error = redactText(cause.message, secrets);
                    break;
                }
            }
            return { images, usage, error };
        },
    };
}

/**
 * @param {'openai' | 'gemini'} name
 * @param {{ apiKey?: string, baseUrl?: string, fetchImpl?: typeof fetch, retryDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>, onRetry?: (message: string) => void }} options
 */
export function createProvider(name, { apiKey, baseUrl, fetchImpl = fetch, retryDelayMs = 3000, sleep = wait, onRetry = () => {} }) {
    const options = { apiKey, baseUrl, fetchImpl, retry: { delayMs: retryDelayMs, sleep, onRetry } };
    if (name === 'openai') {
        return createOpenAiProvider(options);
    }
    if (name === 'gemini') {
        return createGeminiProvider(options);
    }
    throw new Error(`Unknown provider "${name}". Use openai or gemini.`);
}
