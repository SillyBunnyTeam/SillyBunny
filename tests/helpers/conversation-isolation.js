import { randomUUID } from 'node:crypto';
import { fetchBodyOrSkip } from './route-fetch.js';

/**
 * Gives a page conversations of its own on a server that other pages share.
 *
 * Conversations are kept on the server, under the persona that makes them, so two specs that run at once against one server
 * with the default persona would list each other's conversations on Home and in the rail. The routes of conversation
 * storage are answered through this proxy instead: the persona in a request gets a prefix that only this page uses, a list
 * holds the conversations that carry the prefix, and the prefix is taken off again in every answer. The page and the spec
 * see the persona that they know, and the server stores one that no other page can reach.
 *
 * It leaves a request alone that it cannot read (a compressed body) and every answer that is not JSON.
 * @param {import('@playwright/test').Page} page
 */
export async function isolateConversations(page) {
    const prefix = `qa-${randomUUID().slice(0, 8)}-`;
    await page.route('**/api/sillybunny-conversation/**', async (route) => {
        const request = route.request();
        if (request.method() !== 'POST' || request.headers()['content-encoding']) {
            return route.fallback();
        }
        let body;
        try {
            body = JSON.parse(request.postData() || '{}');
        } catch {
            return route.fallback();
        }
        if (typeof body?.personaId === 'string' && !body.personaId.startsWith(prefix)) {
            body = { ...body, personaId: `${prefix}${body.personaId}` };
        }
        const headers = { ...request.headers() };
        delete headers['content-length'];
        const fetched = await fetchBodyOrSkip(route, response => response.body(), { headers, postData: JSON.stringify(body) });
        if (!fetched) {
            return;
        }
        const { response, body: buffer } = fetched;
        // `application/x-ndjson`, the type of an exported chat, holds the word but is not one JSON value.
        if (!/^application\/(?:[\w.-]+\+)?json\s*(?:;|$)/i.test(String(response.headers()['content-type'] ?? ''))) {
            return route.fulfill({ response, body: buffer });
        }
        let json = JSON.parse(buffer.toString());
        if (Array.isArray(json?.conversations)) {
            json = { ...json, conversations: json.conversations.filter(conversation => String(conversation?.personaId ?? '').startsWith(prefix)) };
        }
        return route.fulfill({ status: response.status(), json: JSON.parse(JSON.stringify(json).split(prefix).join('')) });
    });
}
