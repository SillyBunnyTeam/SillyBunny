import { redactText } from './redact.mjs';

/**
 * Reads the relay's token usage endpoint (new-api: GET /api/usage/token/) and converts quota units to dollars.
 * `availableUsd` is undefined when the token has no `user_quota`.
 * Throws a redacted error on any failure; callers treat the balance as advisory.
 * @param {{ apiKey: string, baseUrl: string, unitsPerUsd: number, fetchImpl?: typeof fetch }} options
 */
export async function readBalance({ apiKey, baseUrl, unitsPerUsd, fetchImpl = fetch }) {
    const url = new URL('/api/usage/token/', new URL(baseUrl).origin);
    let response;
    try {
        response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
        throw new Error(`balance request failed: ${redactText(error.message, [apiKey])}`);
    }
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`balance request returned HTTP ${response.status}: ${redactText(text.slice(0, 200), [apiKey])}`);
    }
    let data;
    try {
        data = JSON.parse(text).data;
    } catch {
        throw new Error('balance response was not JSON.');
    }
    const totalUsedUnits = data?.total_used;
    if (!Number.isFinite(totalUsedUnits)) {
        throw new Error('balance response lacks data.total_used.');
    }
    // Some tokens (the Gemini one) report usage but no account quota; the balance is then absent, not zero.
    const availableUnits = data.user_quota?.total_available;
    const hasBalance = Number.isFinite(availableUnits);
    return {
        totalUsedUnits,
        usedUsd: totalUsedUnits / unitsPerUsd,
        availableUnits: hasBalance ? availableUnits : undefined,
        availableUsd: hasBalance ? availableUnits / unitsPerUsd : undefined,
    };
}
