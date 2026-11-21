import { getRequestHeaders } from '../script.js';

/**
 * Gets the text of a lorebook export. The editor holds the lorebook in the browser, but only the server can read the
 * manifests that name the original URL of each media file that an import stored.
 * If the server cannot answer, the lorebook is exported as the editor holds it.
 * @param {object} data Lorebook data from the editor
 * @returns {Promise<string>} JSON text for the export file
 */
export async function getWorldInfoExportText(data) {
    try {
        const response = await fetch('/api/worldinfo/export', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ data }),
        });
        if (response.ok) {
            return await response.text();
        }
    } catch (error) {
        console.warn('Could not ask the server for the original media URLs of a lorebook export:', error);
    }
    return JSON.stringify(data);
}
