import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READY_MESSAGE, SERVER_LIST_VARIABLE, getServerCommand } from './e2e-servers.js';

// Starts all test servers at once, because Playwright starts its webServer entries one after another. The servers
// stay in the process group of this launcher, and Playwright stops that group when the run ends.

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const servers = JSON.parse(process.env[SERVER_LIST_VARIABLE]);
const READY_TIMEOUT_MS = 120_000;
const LOG_LINES_KEPT = 40;
const children = [];
let ready = false;

function report(message, lines = []) {
    // The write is synchronous, so the message is out before the process group stops.
    fs.writeSync(2, `${message}\n${lines.map(line => `  ${line}`).join('\n')}\n`);
}

/**
 * Stops all servers and this launcher. Playwright stops the process group only while the launcher runs, so a
 * launcher that stops by itself must stop the servers first.
 */
function stopAll() {
    if (process.platform === 'win32') {
        for (const { child } of children) {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        }
        process.exit(1);
    }
    process.kill(0, 'SIGKILL');
}

function fail(message, lines) {
    report(message, lines);
    stopAll();
}

function isPortInUse(port) {
    return new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

async function waitUntilAnswering({ url }, { label, lines }) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const answered = await fetch(url, { signal: AbortSignal.timeout(2_000) }).then(response => response.status < 500, () => false);
        if (answered) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    fail(`${label} did not answer within ${READY_TIMEOUT_MS / 1000} s. Its last output:`, lines);
}

for (const [index, server] of servers.entries()) {
    const label = `Test server ${index + 1} (${server.url})`;
    // The port was free when the config chose it. Another process may have taken it since then.
    if (await isPortInUse(server.port)) {
        fail(`${label} cannot start, because another process listens on port ${server.port}.`);
    }

    const lines = [];
    const keep = data => {
        lines.push(...data.toString().split('\n').filter(Boolean));
        lines.splice(0, Math.max(0, lines.length - LOG_LINES_KEPT));
    };
    const { command, args } = getServerCommand(process.env, server);
    const child = spawn(command, args, { cwd: repositoryDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', error => fail(`${label} could not start: ${error.message}`, lines));
    child.on('exit', (code, signal) => {
        const message = `${label} stopped ${ready ? 'during the tests' : 'before it was ready'} (${signal ?? `exit code ${code}`}). Its last output:`;
        if (ready) {
            report(message, lines);
        } else {
            fail(message, lines);
        }
    });
    children.push({ child, label, lines });
}

await Promise.all(servers.map((server, index) => waitUntilAnswering(server, children[index])));
ready = true;
process.stdout.write(`${READY_MESSAGE}\n`);
