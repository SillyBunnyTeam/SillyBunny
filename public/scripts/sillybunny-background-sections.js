/*
 * The model behind the Backgrounds gallery's folder sections. It has no DOM and no settings access, so the rules
 * that decide what the gallery shows can be tested alone. It loads with the gallery, not at startup.
 */

/**
 * The sections of the Global tab for one render.
 *
 * A file that upstream data placed in several folders shows in each of them and is unfiled in none. A member that is not
 * among the images is ignored. With a query, a folder with no match is left out, and a folder with a match shows open
 * without its stored state changing.
 * @param {object} options
 * @param {Array<{ filename: string }>} options.images  Every background the server listed.
 * @param {Array<{ id: string, name: string, color: string, expanded: boolean }>} options.folders  In display order.
 * @param {(folderId: string) => Iterable<string>} options.getMembers  File names the folder holds.
 * @param {string} [options.query]
 * @param {(files: string[]) => string[]} [options.sortFiles]  Orders file names as the gallery's sort asks.
 * @returns {{
 *   sections: Array<{ folder: object, files: string[], total: number, expanded: boolean, temporary: boolean }>,
 *   unfiled: string[],
 *   showUnfiledHeading: boolean,
 *   hasMatches: boolean,
 * }}
 */
export function buildBackgroundSections({ images, folders, getMembers, query = '', sortFiles = files => files }) {
    const needle = String(query ?? '').trim().toLowerCase();
    const known = new Set(images.map(image => image.filename));
    const matching = new Set(images.filter(image => !needle || image.filename.toLowerCase().includes(needle)).map(image => image.filename));
    const filed = new Set();
    const sections = [];
    for (const folder of folders) {
        const members = [...new Set(getMembers(folder.id))].filter(file => known.has(file));
        for (const file of members) filed.add(file);
        const files = sortFiles(members.filter(file => matching.has(file)));
        if (needle && !files.length) continue;
        sections.push({
            folder,
            files,
            total: needle ? files.length : members.length,
            expanded: needle ? true : folder.expanded,
            temporary: Boolean(needle) && !folder.expanded,
        });
    }
    const unfiled = sortFiles([...matching].filter(file => !filed.has(file)));
    return {
        sections,
        unfiled,
        showUnfiledHeading: folders.length > 0 && unfiled.length > 0,
        hasMatches: sections.length > 0 || unfiled.length > 0,
    };
}
