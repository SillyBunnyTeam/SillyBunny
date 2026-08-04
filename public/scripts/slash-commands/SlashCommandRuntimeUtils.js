function isSlashCommandClosureLike(value) {
    return Boolean(value)
        && typeof value === 'object'
        && value.constructor?.name === 'SlashCommandClosure'
        && Array.isArray(value.executorList)
    ;
}

export function isTrueBoolean(arg) {
    return ['on', 'true', '1'].includes(arg?.trim?.()?.toLowerCase?.() ?? '');
}

/**
 * Reads a stored variable value, converting it to a number where that is lossless.
 *
 * SillyBunny diverges from upstream here: upstream returns Number(value) for anything
 * numeric-looking, which rewrites '00' to 0 and '0.50' to 0.5 on every read. The stored
 * value is fine; only the read loses the text. Converting only when the number renders
 * back to the same characters keeps every genuinely numeric value behaving as before.
 *
 * Lives in this leaf module because getLocalVariable, getGlobalVariable, and
 * SlashCommandScope.getVariable all need it, while variables.js imports
 * SlashCommandScope.js. A shared helper in either of those would be circular.
 *
 * @param {any} value Raw stored value.
 * @returns {any} The number, or the value unchanged.
 */
export function readVariableValue(value) {
    if (value?.trim?.() === '' || isNaN(Number(value))) {
        return value || '';
    }

    // Non-strings arrive from the index path via JSON.parse. Number(false) is 0 but
    // Number('false') is NaN, so they must not be compared as text.
    if (typeof value === 'string' && String(Number(value)) !== value.trim()) {
        return value;
    }

    return Number(value);
}

/**
 * Whether an operand can take part in a numeric comparison.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isNumericOperand(value) {
    if (typeof value === 'number') {
        return true;
    }
    return typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value));
}

/**
 * Whether an operand is a numeric representation of zero.
 *
 * @param {any} value
 * @returns {boolean}
 */
export function isNumericZero(value) {
    return isNumericOperand(value) && Number(value) === 0;
}

/**
 * Converts a boolean operand to the string spelling used before formatted
 * numeric variable values were preserved on read.
 *
 * @param {any} value
 * @returns {string}
 */
export function booleanOperandToString(value) {
    const comparableValue = isNumericOperand(value) ? Number(value) : value;
    return (typeof comparableValue === 'string' ? comparableValue : JSON.stringify(comparableValue)).toLowerCase();
}

export function uuidv4() {
    if ('randomUUID' in crypto) {
        return crypto.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function escapeRegex(string) {
    return String(string).replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

export function convertValueType(value, type) {
    if (isSlashCommandClosureLike(value) || typeof type !== 'string') {
        return value;
    }

    switch (type.trim().toLowerCase()) {
        case 'string':
        case 'str':
            return String(value);

        case 'null':
            return null;

        case 'undefined':
        case 'none':
            return undefined;

        case 'number':
            return Number(value);

        case 'int':
            return parseInt(value, 10);

        case 'float':
            return parseFloat(value);

        case 'boolean':
        case 'bool':
            return isTrueBoolean(value);

        case 'list':
        case 'array':
            try {
                const parsedArray = JSON.parse(value);
                return Array.isArray(parsedArray) ? parsedArray : [];
            } catch {
                return [];
            }

        case 'object':
        case 'dict':
        case 'dictionary':
            try {
                const parsedObject = JSON.parse(value);
                return typeof parsedObject === 'object' ? parsedObject : {};
            } catch {
                return {};
            }

        default:
            return value;
    }
}
