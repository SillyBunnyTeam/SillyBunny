const CHARGED = /("chargedUsd":\s*)[0-9.eE+-]+/;
const roundUsd = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Lowers an inflated `chargedUsd` to the price times the images, on every log line from `from` on. A charge measured from the
 * balance change counts every run on the token, so one measured while another run was spending is too high; a charge at or under
 * the price is left alone. Only the number changes: the rest of the line, and every other line, stays byte for byte as it was.
 * @param {string} text the whole log
 * @param {{ from: string, priceOf: (model: string) => number | undefined }} options `priceOf` gives the price of one image, or undefined when the model is not priced per image
 */
export function capInflatedCharges(text, { from, priceOf }) {
    const cutOff = Date.parse(from);
    if (!Number.isFinite(cutOff)) {
        throw new Error(`--from must be a date and time such as 2026-11-01T09:10:00Z, got "${from}".`);
    }
    const changes = [];
    const lines = text.split('\n').map((raw, index) => {
        const entry = parseLine(raw);
        if (!entry || !(Date.parse(entry.time) >= cutOff) || !Number.isFinite(entry.chargedUsd)) {
            return raw;
        }
        const price = priceOf(entry.model);
        if (price === undefined || !Number.isInteger(entry.n)) {
            return raw;
        }
        const ceiling = roundUsd(price * entry.n);
        if (entry.chargedUsd <= ceiling) {
            return raw;
        }
        changes.push({ line: index + 1, time: entry.time, template: entry.template, n: entry.n, from: entry.chargedUsd, to: ceiling });
        return raw.replace(CHARGED, `$1${ceiling}`);
    });
    return { text: lines.join('\n'), changes };
}

function parseLine(raw) {
    if (!raw.trim()) {
        return undefined;
    }
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}
