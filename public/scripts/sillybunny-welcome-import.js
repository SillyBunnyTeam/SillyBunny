const FOLDER_ENDPOINT = '/api/users/import-sillytavern/folder';
const ZIP_ENDPOINT = '/api/users/import-sillytavern/zip';

/**
 * @typedef {{ status: 'imported', message: string } | { status: 'failed', message: string }
 *     | { status: 'empty' } | { status: 'cancelled' } | { status: 'busy' }} ImportResult
 */

/**
 * Runs the SillyTavern imports of the server for the Welcome dialog. An import replaces the settings of the account,
 * so the marker is set before the request: the boot after the reload must not show Welcome to an account that
 * the user has just filled with their own data. A failed request clears the marker again and stays on the page. That
 * is a guess: the server copies section by section, so a failure part-way may have replaced earlier sections, and a
 * gateway timeout can arrive after the server finished.
 * @param {object} deps
 * @param {(endpoint: string, options: { body: unknown, useFormData?: boolean }) => Promise<{ message?: string }>} deps.request
 * @param {(sourceName: string) => Promise<boolean>} deps.confirm Asks the user to replace the data of the account.
 * @param {() => void} deps.reload
 * @param {() => void} deps.markImportPending
 * @param {() => void} deps.clearImportPending
 */
export function createSillyTavernImport({ request, confirm, reload, markImportPending, clearImportPending }) {
    let busy = false;

    /**
     * @param {string} sourceName What the user is asked to confirm.
     * @param {string} endpoint
     * @param {{ body: unknown, useFormData?: boolean }} options
     * @returns {Promise<ImportResult>}
     */
    async function run(sourceName, endpoint, options) {
        if (busy) {
            return { status: 'busy' };
        }
        busy = true;
        try {
            if (!(await confirm(sourceName))) {
                return { status: 'cancelled' };
            }
            markImportPending();
            try {
                const result = await request(endpoint, options);
                reload();
                return { status: 'imported', message: result?.message ?? '' };
            } catch (error) {
                clearImportPending();
                return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
            }
        } finally {
            busy = false;
        }
    }

    return {
        /**
         * @param {string} sourcePath The folder on the server.
         * @returns {Promise<ImportResult>}
         */
        async importFolder(sourcePath) {
            const path = String(sourcePath ?? '').trim();
            if (!path) {
                return { status: 'empty' };
            }
            return run(path, FOLDER_ENDPOINT, { body: { sourcePath: path } });
        },

        /**
         * @param {File} file The backup ZIP.
         * @returns {Promise<ImportResult>}
         */
        async importZip(file) {
            const body = new FormData();
            body.append('avatar', file, file.name);
            return run(file.name, ZIP_ENDPOINT, { body, useFormData: true });
        },
    };
}
