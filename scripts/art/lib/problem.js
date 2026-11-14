/** Problems with these codes come from the install, not from the art, and make the command exit with 3. */
export const ENVIRONMENT_CODES = Object.freeze(['encoder-mismatch', 'sharp-missing', 'card-parser-missing']);

/** A reason the art cannot be derived or proven, with a stable code that the art repository reads from the JSON. */
export class ArtProblem extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{ asset?: string, path?: string, expected?: unknown, actual?: unknown }} [details]
     */
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'ArtProblem';
        this.code = code;
        this.details = details;
    }

    /** @returns {{ code: string, message: string }} The problem as the JSON output lists it. */
    toJSON() {
        return { code: this.code, ...this.details, message: this.message };
    }
}

/**
 * @param {{ code: string }[]} problems
 * @returns {0 | 1 | 3} 3 when the install is the problem, 1 for any other problem, 0 for none.
 */
export function exitCodeOf(problems) {
    if (problems.some(({ code }) => ENVIRONMENT_CODES.includes(code))) {
        return 3;
    }
    return problems.length > 0 ? 1 : 0;
}
