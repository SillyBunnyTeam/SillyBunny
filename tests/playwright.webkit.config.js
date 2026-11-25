import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.js';

// The dialog frame, side panels and their callers. Safari/iOS WebKit is a supported baseline, and these
// surfaces rely on `<dialog>`, `inert`, `backdrop-filter` and touch gestures, where WebKit differs most. The last three
// specs measure the layout that settings pages, windows and panels share: percentage padding, `vw` widths and transitions.
// `conversation-list` is here for the drag of a row by pointer events, the one Tab stop of the list and its menu keys;
// `conversation-folders` for the drop of a row on a folder, the Alt keys across the sections and the menu of a heading.
// `conversation-emoji-chooser` is here for the roving grid, the bottom sheet, the long press and the colour font, which differ per engine.
export const DIALOG_SPECS = [
    'conversation-emoji-chooser',
    'conversation-list',
    'conversation-folders',
    'sillybunny-dialog-frame',
    'sillybunny-dialog-tiers',
    'popup-scroll',
    'popup-animation-none',
    'window-dialogs',
    'window-content-dialogs',
    'window-media-dialogs',
    'window-tools-dialogs',
    'tag-manager',
    'character-folders',
    'native-dialog-replacements',
    'side-panel-engine',
    'side-panel-adapters',
    'sheet-swipe',
    'sillybunny-chats-archive',
    'sillybunny-chats-archive-layout',
    'sillybunny-overlays',
    'utility-dialogs',
    'utility-dialog-first-paint',
    'destructive-first-paint',
    'misc-form-dialogs',
    'preset-lorebook-dialogs',
    'connection-manager-dialogs',
    'dialogs-accessibility',
    'dialog-opening-layout',
    'welcome-transitions',
    'settings-content-clamp',
    'side-panel-wide-step',
    'chat-column-resize',
];

// Opt-in: `npm run test:e2e:webkit`. The default config stays Chromium only.
export default defineConfig({
    ...baseConfig,
    testMatch: DIALOG_SPECS.map(name => `**/${name}.e2e.js`),
    // Playwright's `page.route` does not see a request that a service worker handles. The app's worker claims
    // the page, so stubs are skipped for the requests it takes over, and a destructive call such as
    // /api/users/reset-settings reaches the real server. Blocking the worker keeps every request routable.
    projects: [{ name: 'webkit', use: { browserName: 'webkit', serviceWorkers: 'block' } }],
});
