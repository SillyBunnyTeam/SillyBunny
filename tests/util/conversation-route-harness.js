import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

/**
 * Serves the conversation router on a local port. Each request gets the user that `getUser()` returns now, with a
 * handle of its own: the regular chat backup is throttled per handle and chat, and a second save inside the window
 * would leave a timer that fires after the test.
 * @param {() => { profile: { handle: string }, directories: Record<string, string> }} getUser
 */
export async function startConversationRouter(getUser) {
    const { router } = await import('../../src/endpoints/sillybunny-conversation.js');
    const prefix = '/api/sillybunny-conversation';
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    let requests = 0;
    app.use((request, _response, next) => {
        const user = getUser();
        request.user = { ...user, profile: { handle: `${user.profile.handle}-request-${++requests}` } };
        next();
    });
    app.use(prefix, router);
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    return {
        prefix,
        baseUrl,
        close: () => new Promise(resolve => server.close(resolve)),
        async post(route, body) {
            const response = await fetch(`${baseUrl}${prefix}${route}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: typeof body === 'string' ? body : JSON.stringify(body),
            });
            const text = await response.text();
            let json = null;
            try {
                json = JSON.parse(text);
            } catch {
                // The body is not JSON; the test reads `text`.
            }
            return { status: response.status, json, text, headers: response.headers };
        },
    };
}

/** Every file and folder under a root, for a check that a refused request wrote nothing. */
export function snapshotTree(root) {
    const entries = [];
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            entries.push(`${path.relative(root, entryPath)}${entry.isDirectory() ? '/' : `:${fs.statSync(entryPath).size}`}`);
            if (entry.isDirectory()) {
                walk(entryPath);
            }
        }
    };
    walk(root);
    return entries.sort();
}
