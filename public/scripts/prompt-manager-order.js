/**
 * Reorders rendered prompts while keeping omitted entries with their preceding row.
 * @template {{ identifier: string }} T
 * @param {T[]} promptOrder Complete persisted order.
 * @param {string[]} reorderedIdentifiers Identifiers in the new rendered order.
 * @returns {T[]} Complete order, including collapsed marker children.
 */
export function reorderPromptOrder(promptOrder, reorderedIdentifiers) {
    const renderedIdentifiers = new Set(reorderedIdentifiers);
    const orderIdentifiers = new Set(promptOrder.map(entry => entry.identifier));
    if (orderIdentifiers.size !== promptOrder.length
        || renderedIdentifiers.size !== reorderedIdentifiers.length
        || reorderedIdentifiers.some(identifier => !orderIdentifiers.has(identifier))) {
        return [...promptOrder];
    }
    const blocks = new Map();
    const leadingEntries = [];
    let currentBlock = leadingEntries;

    // SillyBunny: collapsed children have no DOM rows, but must move with their marker.
    for (const entry of promptOrder) {
        if (renderedIdentifiers.has(entry.identifier)) {
            currentBlock = [];
            blocks.set(entry.identifier, currentBlock);
        }
        currentBlock.push(entry);
    }

    const reordered = [...leadingEntries];
    for (const identifier of reorderedIdentifiers) {
        const block = blocks.get(identifier);
        if (block) {
            reordered.push(...block);
        }
    }
    return reordered;
}
