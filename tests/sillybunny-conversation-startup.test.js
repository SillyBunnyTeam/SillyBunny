import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from '@jest/globals';

const publicScripts = fileURLToPath(new URL('../public/scripts/', import.meta.url));
const conversationDirectory = path.join(publicScripts, 'sillybunny-conversation') + path.sep;
const entry = path.join(publicScripts, 'sillybunny-conversation.js');

// The modules that a start fetches for the mode: `tests/frontend-performance.e2e.js` counts every one of them against
// STARTUP_RESOURCE_LIMIT. A module belongs here only when the page of a user who has no conversation needs it: the start
// of the data module on SETTINGS_LOADED, the unread badges and the favicon, the notifications, Home's recents and the
// import of the old browser data. The worker, the asides, the reply stream and the generation behind them are the
// runtime (`runtime.js`), and the interface is the workspace (`chrome.js`). Both load through `lazy-parts.js`.
const STARTUP_MODULES = [
    'constants.js',
    'context.js',
    'conversation-data-browser.js',
    'conversation-data-merge.js',
    'conversation-data-queue.js',
    'conversation-data.js',
    'conversation-store-utils.js',
    'conversation-summary.js',
    'deletion-guards.js',
    'index.js',
    'init.js',
    'lazy-parts.js',
    'legacy-import.js',
    'memory-utils.js',
    'notifications.js',
    'pending-reply.js',
    'preview-utils.js',
    'reminders.js',
    'render-scheduler.js',
    'schedule-utils.js',
    'settings-store.js',
    'state.js',
];

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** The source without its comments, whose JSDoc types name modules with `import('...')`. */
function readCode(file) {
    return readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function resolveRelative(from, specifier) {
    return specifier.startsWith('.') ? path.resolve(path.dirname(from), specifier) : null;
}

/** The modules of the mode that a start file imports with `import`, each with the module that pulled it in. */
function findStaticClosure(start = entry) {
    const importedBy = new Map([[start, null]]);
    const queue = [start];
    while (queue.length) {
        const file = queue.shift();
        for (const [, specifier] of readCode(file).matchAll(STATIC_IMPORT)) {
            const target = resolveRelative(file, specifier);
            if (target && target.startsWith(conversationDirectory) && !importedBy.has(target)) {
                importedBy.set(target, file);
                queue.push(target);
            }
        }
    }
    return importedBy;
}

function describeChain(importedBy, file) {
    const chain = [];
    for (let current = file; current; current = importedBy.get(current)) {
        chain.unshift(path.basename(current));
    }
    return chain.join(' -> ');
}

describe('the modules that the startup of Conversation Mode imports', () => {
    test('are the ones that the page of a user without a conversation needs, with no interface or runtime module', () => {
        const importedBy = findStaticClosure();
        const startup = [...importedBy.keys()].filter(file => file !== entry);
        const unexpected = startup
            .filter(file => !STARTUP_MODULES.includes(path.relative(conversationDirectory, file)))
            .map(file => describeChain(importedBy, file));

        expect(unexpected).toEqual([]);
        expect(startup.map(file => path.relative(conversationDirectory, file)).sort()).toEqual(STARTUP_MODULES);
    });

    test('are the only ones of the mode that the module for the messages of the page imports, which is `message-menu.js`, with nothing of the runtime', () => {
        // `sillybunny-message-actions.js` is loaded with the page, outside the entry of the mode, and imports the menu of a message.
        const startup = [...findStaticClosure(path.join(publicScripts, 'sillybunny-message-actions.js')).keys()]
            .filter(file => file.startsWith(conversationDirectory))
            .map(file => path.relative(conversationDirectory, file));

        expect(startup).toEqual(['message-menu.js']);
    });

    test('reach the workspace and the runtime only through dynamic imports in lazy-parts.js', () => {
        const source = readCode(path.join(conversationDirectory, 'lazy-parts.js'));
        const staticTargets = [...source.matchAll(STATIC_IMPORT)].map(([, specifier]) => specifier);
        const dynamicTargets = [...source.matchAll(DYNAMIC_IMPORT)].map(([, specifier]) => specifier);

        expect(staticTargets).not.toContain('./chrome.js');
        expect(staticTargets).not.toContain('./runtime.js');
        expect(dynamicTargets.sort()).toEqual(['./chrome.js', './runtime.js']);
    });
});
