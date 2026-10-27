import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.js';

// The dialog frame, side panels and their callers. Safari/iOS WebKit is a supported baseline, and these
// surfaces rely on `<dialog>`, `inert`, `backdrop-filter` and touch gestures, where WebKit differs most.
const DIALOG_SPECS = [
    'sillybunny-dialog-frame',
    'sillybunny-dialog-tiers',
    'popup-scroll',
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
    'misc-form-dialogs',
    'preset-lorebook-dialogs',
    'connection-manager-dialogs',
    'dialogs-accessibility',
];

// Opt-in: `npm run test:e2e:webkit`. The default config stays Chromium only.
export default defineConfig({
    ...baseConfig,
    testMatch: DIALOG_SPECS.map(name => `**/${name}.e2e.js`),
    projects: [{ name: 'webkit', use: { browserName: 'webkit' } }],
});
