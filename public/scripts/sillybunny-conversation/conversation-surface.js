/**
 * Opens a surface that `chrome.js` exports for the list to call, such as the details window and Preferences. The
 * import is dynamic and the export is looked up at the call, so the list works while a surface is still missing.
 */

/**
 * @param {() => Promise<Record<string, any>>} load Gives the module that exports the surfaces.
 * @returns {(name: string, ...args: any[]) => Promise<boolean>} Resolves to false when the module does not export `name` yet.
 */
export function createSurfaceOpener(load) {
    return async (name, ...args) => {
        const surfaces = await load();
        const opener = surfaces[name];
        if (typeof opener !== 'function') {
            console.warn(`Conversation Mode: ${name} is not available yet`);
            return false;
        }
        await opener(...args);
        return true;
    };
}

export const openConversationSurface = createSurfaceOpener(() => import('./chrome.js'));
