/**
 * SillyBunny: lets an extension hide chat lines from the speaker of one generation before Generate merges
 * retained Companion notes into the prompt history. A hidden line's notes are then never merged, and a
 * hidden line never hosts the merge. Handlers answer by index into `request.messages`, shallow copies of
 * the lines in prompt order (`extra` is shared, as it is for generate interceptors); the stored messages
 * are never handed out, and blanking the prompt copies stays with the generate interceptor.
 */

/**
 * @typedef {object} GenerationHideRequest
 * @property {string} type Generation type
 * @property {object[]} messages Frozen array of shallow copies of the prompt lines, in prompt order; each copy is a plain object whose `extra` is the stored one
 * @property {(index: number) => boolean} hide Hides the line at `index` of `messages`; true when the index names a line
 * @property {(index: number) => boolean} isHidden Whether the line at `index` was hidden by any handler
 */

/**
 * @param {object[]} messages Prompt-order chat lines; never exposed to handlers
 * @param {string} type Generation type
 * @returns {{ request: GenerationHideRequest, hidden: Set<object> }} The request and the set of hidden lines
 */
export function createGenerationHideRequest(messages, type) {
    const lines = Array.isArray(messages) ? messages : [];
    const hidden = new Set();
    const inRange = index => Number.isInteger(index) && index >= 0 && index < lines.length;
    let copies = null;
    const request = {
        type,
        get messages() {
            copies ??= Object.freeze(lines.map(line => (line && typeof line === 'object' ? { ...line } : line)));
            return copies;
        },
        hide(index) {
            if (!inRange(index)) return false;
            hidden.add(lines[index]);
            return true;
        },
        isHidden(index) {
            return inRange(index) && hidden.has(lines[index]);
        },
    };
    return { request, hidden };
}

/**
 * Emits a hide request and returns the lines the handlers hid. A failing emit keeps whatever was hidden
 * before it failed.
 * @param {object[]} messages Prompt-order chat lines
 * @param {string} type Generation type
 * @param {(request: GenerationHideRequest) => Promise<unknown>|unknown} emit Delivers the request to the handlers
 * @returns {Promise<Set<object>>} The hidden lines
 */
export async function collectHiddenGenerationMessages(messages, type, emit) {
    const { request, hidden } = createGenerationHideRequest(messages, type);
    try {
        await emit(request);
    } catch (error) {
        console.warn('Generation hide request failed; nothing more is hidden', error);
    }
    return hidden;
}
