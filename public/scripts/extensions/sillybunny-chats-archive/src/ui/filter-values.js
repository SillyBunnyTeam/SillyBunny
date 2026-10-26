export function commaValues(value) {
    return String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
}

export function inputNumber(input, multiplier = 1, integer = false) {
    if (!input.value.trim()) {
        return undefined;
    }
    const value = Number(input.value) * multiplier;
    return Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined;
}

export function inputDate(input, endOfDay = false) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value);
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
