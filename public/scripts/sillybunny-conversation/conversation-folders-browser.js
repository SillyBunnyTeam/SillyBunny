/**
 * The folders module of this page: `createConversationFolders()` on the browser's `fetch`, the clock and the page's
 * random source, kept in step with the data module, and the hooks that write what waits when the page is left. Only the
 * workspace imports it, so a page that never opens the workspace never loads it.
 */

import { conversationData, fetchJson } from './conversation-data-browser.js';
import { createConversationFolders } from './conversation-folders.js';

function randomHex(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}

export const conversationFolders = createConversationFolders({
    fetchJson,
    now: () => Date.now(),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: handle => clearTimeout(handle),
    randomHex,
});

// A group that was converted into a direct conversation, a persona or a character that was deleted: the server moved or
// dropped folder entries together with it, so the page reads the file again whenever it reads the conversations again.
conversationData.onLoad(() => {
    if (conversationFolders.status() === 'ready') {
        void conversationFolders.refresh();
    }
});

const flushForLeaving = () => {
    void conversationFolders.flush({ keepalive: true });
};
window.addEventListener('pagehide', flushForLeaving);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        flushForLeaving();
    }
});
