import http from 'node:http';
import { afterEach, describe, expect, test } from '@jest/globals';

import { KEEP_ALIVE_IDLE_TIMEOUT_MS, getKeepAliveAgentOptions } from '../src/outbound-keep-alive.js';

/** @type {import('node:http').Server[]} */
const servers = [];
/** @type {import('node:http').Agent[]} */
const agents = [];

afterEach(async () => {
    for (const agent of agents.splice(0)) {
        agent.destroy();
    }
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    })));
});

async function listen(handler) {
    const connections = { opened: 0, closed: 0 };
    const server = http.createServer(handler);
    server.keepAliveTimeout = 60_000;
    server.on('connection', socket => {
        connections.opened++;
        socket.on('close', () => connections.closed++);
    });
    servers.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, connections };
}

function get(agent, port, path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, agent }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('outbound keep-alive agent options', () => {
    test('keep-alive is on only when the caller turns it on', () => {
        expect(getKeepAliveAgentOptions(false).keepAlive).toBe(false);
        expect(getKeepAliveAgentOptions(true).keepAlive).toBe(true);
    });

    test('a pooled socket idles for less than the 5 s that Node.js and Apache servers allow', () => {
        const { timeout } = getKeepAliveAgentOptions(true);
        expect(timeout).toBe(KEEP_ALIVE_IDLE_TIMEOUT_MS);
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThan(5000);
    });

    test('the client closes a free socket after the idle timeout and opens a new one for the next request', async () => {
        const { port, connections } = await listen((_req, res) => res.end('ok'));
        const agent = new http.Agent({ ...getKeepAliveAgentOptions(true, 150) });
        agents.push(agent);

        await get(agent, port, '/');
        await get(agent, port, '/');
        expect(connections.opened).toBe(1);

        await sleep(400);
        expect(connections.closed).toBe(1);

        await get(agent, port, '/');
        expect(connections.opened).toBe(2);
    });

    test('a response that stays silent for longer than the idle timeout still arrives', async () => {
        const { port } = await listen((_req, res) => setTimeout(() => res.end('late'), 500));
        const agent = new http.Agent({ ...getKeepAliveAgentOptions(true, 150) });
        agents.push(agent);

        await expect(get(agent, port, '/')).resolves.toBe('late');
    });
});
