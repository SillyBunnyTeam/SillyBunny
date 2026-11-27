/* eslint-disable playwright/no-duplicate-hooks */
import { describe, test, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';

const mockNetConnect = jest.fn(() => ({ type: 'net-socket' }));
const mockTlsConnect = jest.fn(() => ({ type: 'tls-socket' }));
const mockLookup = jest.fn();

jest.unstable_mockModule('node:net', () => ({
    default: { connect: mockNetConnect },
}));

jest.unstable_mockModule('node:tls', () => ({
    default: { connect: mockTlsConnect },
}));

jest.unstable_mockModule('node:dns', () => ({
    default: { promises: { lookup: mockLookup } },
}));

jest.unstable_mockModule('../src/util.js', () => ({
    color: {
        red: text => text,
        green: text => text,
        blue: text => text,
        yellow: text => text,
    },
}));

jest.unstable_mockModule('../src/express-common.js', () => ({
    filterValidIpPatterns: patterns => patterns,
}));

/** @type {import('../src/private-request-filter.js').default} */
let initPrivateRequestFilter;
/** @type {import('../src/private-request-filter.js').getUntrustedRequestAgent} */
let getUntrustedRequestAgent;
/** @type {import('node:http').default} */
let http;
/** @type {import('node:https').default} */
let https;
let originalHttpGlobalAgent;
let originalHttpsGlobalAgent;

beforeAll(async () => {
    ({ default: initPrivateRequestFilter, getUntrustedRequestAgent } = await import('../src/private-request-filter.js'));
    ({ default: http } = await import('node:http'));
    ({ default: https } = await import('node:https'));
    originalHttpGlobalAgent = http.globalAgent;
    originalHttpsGlobalAgent = https.globalAgent;
});

beforeEach(() => {
    mockNetConnect.mockClear();
    mockTlsConnect.mockClear();
    mockLookup.mockReset();
    http.globalAgent = originalHttpGlobalAgent;
    https.globalAgent = originalHttpsGlobalAgent;
});

afterAll(() => {
    http.globalAgent = originalHttpGlobalAgent;
    https.globalAgent = originalHttpsGlobalAgent;
});

function initAgent({ privateAddressWhitelist = [], allowUnresolvedHosts = false, enabled = true, requestProxyEnabled = false } = {}) {
    initPrivateRequestFilter({
        listen: false,
        enabled,
        privateAddressWhitelist,
        logBlocked: false,
        logAllowed: false,
        allowUnresolvedHosts,
        requestProxyEnabled,
    });

    return http.globalAgent;
}

describe('private request filter', () => {
    test('allows direct private IP requests only when whitelisted', async () => {
        const agent = initAgent({ privateAddressWhitelist: ['127.0.0.0/8'] });
        await agent.connect({}, { host: '127.0.0.1', secureEndpoint: false });

        expect(mockNetConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1' }));

        const blockedAgent = initAgent({ privateAddressWhitelist: [] });
        await expect(blockedAgent.connect({}, { host: '127.0.0.1', secureEndpoint: false }))
            .rejects
            .toThrow('Blocked request to private IP address: 127.0.0.1');
    });

    test('resolves hostnames and blocks when DNS returns private IP', async () => {
        mockLookup.mockResolvedValue({ address: '192.168.1.8' });
        const agent = initAgent();

        await expect(agent.connect({}, { host: 'example.com', secureEndpoint: false }))
            .rejects
            .toThrow('Blocked request to private IP address: 192.168.1.8');
        expect(mockNetConnect).not.toHaveBeenCalled();
    });

    test('connects to resolved public IP to avoid hostname re-resolution', async () => {
        mockLookup.mockResolvedValue({ address: '93.184.216.34' });
        const agent = initAgent();

        await agent.connect({}, { host: 'example.com', secureEndpoint: false });

        expect(mockLookup).toHaveBeenCalledWith('example.com');
        expect(mockNetConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '93.184.216.34' }));
    });

    test('handles unresolved hosts according to allowUnresolvedHosts setting', async () => {
        mockLookup.mockRejectedValue(new Error('lookup failed'));
        const blockedAgent = initAgent({ allowUnresolvedHosts: false });

        await expect(blockedAgent.connect({}, { host: 'missing-host.local', secureEndpoint: false }))
            .rejects
            .toThrow('Unable to resolve host: missing-host.local. Set privateAddressWhitelist.allowUnresolvedHosts to true to bypass this check.');
        expect(mockNetConnect).not.toHaveBeenCalled();

        const allowedAgent = initAgent({ allowUnresolvedHosts: true });
        await allowedAgent.connect({}, { host: 'missing-host.local', secureEndpoint: false });
        expect(mockNetConnect).toHaveBeenCalledWith(expect.objectContaining({ host: 'missing-host.local' }));
    });

    test('uses tls.connect for secure endpoints', async () => {
        mockLookup.mockResolvedValue({ address: '93.184.216.34' });
        const agent = initAgent();
        await agent.connect({}, { host: 'example.com', secureEndpoint: true });
        expect(mockLookup).toHaveBeenCalledWith('example.com');
        expect(mockTlsConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '93.184.216.34' }));
        expect(mockNetConnect).not.toHaveBeenCalled();
    });
});

describe('pooled sockets of the filter agent', () => {
    function initKeepAliveAgent(enableKeepAlive) {
        initPrivateRequestFilter({
            listen: false,
            enabled: true,
            privateAddressWhitelist: [],
            logBlocked: false,
            logAllowed: false,
            allowUnresolvedHosts: false,
            enableKeepAlive,
        });
        return http.globalAgent;
    }

    test('keeps sockets alive only when asked to', () => {
        expect(initKeepAliveAgent(true).keepAlive).toBe(true);
        expect(initKeepAliveAgent(false).keepAlive).toBe(false);
    });

    test('a free socket is closed by this process before a server that waits 5 s would close it', () => {
        const { timeout } = initKeepAliveAgent(true).options;
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThan(5000);
    });
});

describe('addresses that reach this host or a private host in another form', () => {
    test.each([
        ['0.0.0.0'],
        ['0.1.2.3'],
        ['::'],
        ['::ffff:127.0.0.1'],
        ['::ffff:7f00:1'],
        ['0:0:0:0:0:ffff:c0a8:101'],
        ['::ffff:169.254.169.254'],
    ])('blocks a direct request to %s', async (host) => {
        const agent = initAgent();

        await expect(agent.connect({}, { host, port: 80 })).rejects.toThrow('Blocked request to private IP address');
        expect(mockNetConnect).not.toHaveBeenCalled();
    });

    test.each([
        ['0.0.0.0'],
        ['::'],
        ['::ffff:10.0.0.5'],
    ])('blocks a hostname that resolves to %s', async (address) => {
        mockLookup.mockResolvedValue({ address });
        const agent = initAgent();

        await expect(agent.connect({}, { host: 'card-host.example', port: 80 })).rejects.toThrow('Blocked request to private IP address');
        expect(mockNetConnect).not.toHaveBeenCalled();
    });

    test('allows the IPv4-mapped form of a whitelisted IPv4 host', async () => {
        const agent = initAgent({ privateAddressWhitelist: ['192.168.1.20'] });

        await agent.connect({}, { host: '::ffff:192.168.1.20', port: 80 });
        expect(mockNetConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '::ffff:192.168.1.20' }));
        await expect(agent.connect({}, { host: '::ffff:192.168.1.21', port: 80 })).rejects.toThrow('Blocked request to private IP address');
    });

    test('allows the IPv4-mapped form of a public IPv4 host', async () => {
        const agent = initAgent();

        await agent.connect({}, { host: '::ffff:93.184.216.34', port: 80 });
        expect(mockNetConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '::ffff:93.184.216.34' }));
    });

    test('the strict agent blocks the same forms', async () => {
        initAgent({ enabled: false });
        const agent = getUntrustedRequestAgent();
        agent.logBlocked = false;

        for (const host of ['0.0.0.0', '::', '::ffff:127.0.0.1']) {
            await expect(agent.connect({}, { host, port: 80 })).rejects.toThrow('Blocked request to private IP address');
        }
        expect(mockNetConnect).not.toHaveBeenCalled();
    });
});

describe('untrusted request agent', () => {
    test('returns undefined when the private request filter is enabled', () => {
        initAgent({ enabled: true });
        expect(getUntrustedRequestAgent()).toBeUndefined();
    });

    test('returns undefined when a request proxy owns outbound routing', () => {
        initAgent({ enabled: false, requestProxyEnabled: true });
        expect(getUntrustedRequestAgent()).toBeUndefined();
    });

    test('returns the same strict agent instance when the filter is disabled', () => {
        initAgent({ enabled: false });
        const agent = getUntrustedRequestAgent();
        expect(agent).toBeDefined();
        expect(getUntrustedRequestAgent()).toBe(agent);
    });

    test('blocks private addresses even when the configured whitelist allows them', async () => {
        initAgent({ enabled: false, privateAddressWhitelist: ['127.0.0.0/8', '::1/128'] });
        const agent = getUntrustedRequestAgent();

        await expect(agent.connect({}, { host: '127.0.0.1', secureEndpoint: false }))
            .rejects
            .toThrow('Blocked request to private IP address: 127.0.0.1');
        await expect(agent.connect({}, { host: '::1', secureEndpoint: false }))
            .rejects
            .toThrow('Blocked request to private IP address: ::1');
        expect(mockNetConnect).not.toHaveBeenCalled();
    });

    test('blocks hostnames that resolve to private addresses', async () => {
        initAgent({ enabled: false });
        mockLookup.mockResolvedValue({ address: '192.168.1.8' });
        const agent = getUntrustedRequestAgent();

        await expect(agent.connect({}, { host: 'internal.example.com', secureEndpoint: false }))
            .rejects
            .toThrow('Blocked request to private IP address: 192.168.1.8');
        expect(mockNetConnect).not.toHaveBeenCalled();
    });

    test('blocks unresolvable hostnames', async () => {
        initAgent({ enabled: false });
        mockLookup.mockRejectedValue(new Error('lookup failed'));
        const agent = getUntrustedRequestAgent();

        await expect(agent.connect({}, { host: 'missing-host.local', secureEndpoint: false }))
            .rejects
            .toThrow('Unable to resolve host: missing-host.local');
        expect(mockNetConnect).not.toHaveBeenCalled();
    });

    test('connects public hostnames to their resolved IP for both http and https', async () => {
        initAgent({ enabled: false });
        mockLookup.mockResolvedValue({ address: '93.184.216.34' });
        const agent = getUntrustedRequestAgent();

        await agent.connect({}, { host: 'example.com', secureEndpoint: false });
        expect(mockNetConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '93.184.216.34' }));

        await agent.connect({}, { host: 'example.com', secureEndpoint: true });
        expect(mockTlsConnect).toHaveBeenCalledWith(expect.objectContaining({ host: '93.184.216.34' }));
    });
});
