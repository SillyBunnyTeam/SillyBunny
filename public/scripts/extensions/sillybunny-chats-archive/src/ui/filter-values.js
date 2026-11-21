const MIB = 1024 ** 2;

export function commaValues(value) {
    return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

function numberValue(text, multiplier, integer = false) {
    if (!String(text ?? '').trim()) {
        return undefined;
    }
    const value = Number(text) * multiplier;
    return Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;
}

export const sizeFromMebibytes = text => numberValue(text, MIB);
export const countFromText = text => numberValue(text, 1, true);

export function mebibytesText(bytes) {
    return bytes === undefined ? '' : String(bytes / MIB);
}

export function countText(count) {
    return count === undefined ? '' : String(count);
}

export function dateFromInput(text, endOfDay = false) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) {
        return undefined;
    }
    const value = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0,
    ).valueOf();
    return Number.isFinite(value) ? value : undefined;
}

export function dateInputText(value) {
    if (value === undefined) {
        return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) {
        return '';
    }
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}
