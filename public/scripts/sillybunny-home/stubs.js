/**
 * Actions that Home shows but does not run yet. A later task wires each one. The markup of a stubbed
 * control also carries `data-sb-stub="true"`.
 */
export const HOME_STUBS = Object.freeze([
    'assistant.new-chat',
    'assistant.temporary-chat',
    'assistant.new-chat-in-mode',
]);

/**
 * @param {string} action One of {@link HOME_STUBS}.
 * @returns {() => void} A function that does nothing.
 */
export function stubAction(action) {
    if (!HOME_STUBS.includes(action)) {
        throw new Error(`"${action}" is not a listed stub.`);
    }
    return () => {};
}
