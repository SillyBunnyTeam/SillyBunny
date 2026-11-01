/**
 * Remembers which assistant is the default for the list of characters it was resolved for. The lists render one item
 * at a time and each item asks for the default, and finding it scans the whole list, so without this a render of N
 * characters scans N times N.
 *
 * The answer is kept while the list is the same array with the same length. The app edits the array in place, so a
 * change that keeps the length (a card renamed, or one removed and another imported) is not seen here, and the owner
 * calls `invalidate` for it.
 * @template T
 * @param {object} options
 * @param {() => readonly unknown[]} options.getCharacters The list of characters as it is now.
 * @param {() => T} options.resolve Finds the default assistant by scanning that list.
 * @returns {{ get: () => T, invalidate: () => void }}
 */
export function createDefaultAssistantResolver({ getCharacters, resolve }) {
    /** @type {{ list: readonly unknown[], length: number, value: T } | null} */
    let remembered = null;

    function get() {
        const list = getCharacters();
        if (remembered && remembered.list === list && remembered.length === list.length) {
            return remembered.value;
        }
        remembered = { list, length: list.length, value: resolve() };
        return remembered.value;
    }

    function invalidate() {
        remembered = null;
    }

    return { get, invalidate };
}
