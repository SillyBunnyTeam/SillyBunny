import { SERVER_LIST_VARIABLE, removeStorageDirectories } from './e2e-servers.js';

/**
 * Removes worker storage-state files once all workers have exited.
 * Playwright stops webServer after globalTeardown, and the main process exit handler then deletes each scratch data root.
 */
export default async function teardownServers() {
    if (!process.env[SERVER_LIST_VARIABLE]) {
        return;
    }
    const servers = JSON.parse(process.env[SERVER_LIST_VARIABLE]);
    removeStorageDirectories(servers);
}
