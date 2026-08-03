import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let tempRoot;

afterEach(() => {
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = undefined;
    }
});

describe('chat save interprocess lock', () => {
    test('keeps the lock through a complete save and rejects the stale process', async () => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-chat-process-lock-'));
        const chatDirectory = path.join(tempRoot, 'chats');
        const backupDirectory = path.join(tempRoot, 'backups');
        const chatFile = path.join(chatDirectory, 'chat.jsonl');
        fs.mkdirSync(chatDirectory, { recursive: true });
        fs.mkdirSync(backupDirectory);
        fs.writeFileSync(chatFile, createChat('shared-integrity', 'before').map(JSON.stringify).join('\n'));

        const releasePath = path.join(tempRoot, 'release-lock');
        const utilUrl = new URL('../src/util.js', import.meta.url).href;
        const chatsUrl = new URL('../src/endpoints/chats.js', import.meta.url).href;
        const configPath = fileURLToPath(new URL('../default/config.yaml', import.meta.url));
        const firstPayload = createChat('shared-integrity', 'first writer');
        const firstScript = `
            import fs from 'node:fs';
            import { setConfigFilePath } from ${JSON.stringify(utilUrl)};
            setConfigFilePath(${JSON.stringify(configPath)});
            const { trySaveChat } = await import(${JSON.stringify(chatsUrl)});
            const identity = fs.statSync(${JSON.stringify(chatFile)}, { bigint: true });
            const writeSync = fs.writeSync.bind(fs);
            let paused = false;
            fs.writeSync = (descriptor, ...args) => {
                const stats = fs.fstatSync(descriptor, { bigint: true });
                if (!paused && stats.dev === identity.dev && stats.ino === identity.ino) {
                    paused = true;
                    process.stdout.write('first-paused\\n');
                    while (!fs.existsSync(${JSON.stringify(releasePath)})) {
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
                    }
                }
                return writeSync(descriptor, ...args);
            };
            await trySaveChat(
                ${JSON.stringify(firstPayload)},
                ${JSON.stringify(chatFile)},
                false,
                'first-process',
                'Test Card',
                ${JSON.stringify(backupDirectory)},
                { deferBackup: true },
            );
            process.stdout.write('first-saved\\n');
        `;
        const first = spawn(process.execPath, ['--input-type=module', '-e', firstScript], {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let firstOutput = '';
        first.stdout.setEncoding('utf8');
        first.stdout.on('data', chunk => firstOutput += chunk);
        const firstExit = waitForChildExit(first);
        await waitForOutput(first, 'first-paused');

        const secondPayload = createChat('shared-integrity', 'second writer');
        const secondScript = `
            import { createRequire } from 'node:module';
            import { setConfigFilePath } from ${JSON.stringify(utilUrl)};
            const require = createRequire(import.meta.url);
            const lockfile = require('proper-lockfile');
            const lockSync = lockfile.lockSync.bind(lockfile);
            let contentionReported = false;
            lockfile.lockSync = (...args) => {
                try {
                    return lockSync(...args);
                } catch (error) {
                    if (!contentionReported && error?.code === 'ELOCKED') {
                        contentionReported = true;
                        process.stdout.write('second-contended\\n');
                    }
                    throw error;
                }
            };
            setConfigFilePath(${JSON.stringify(configPath)});
            const { trySaveChat } = await import(${JSON.stringify(chatsUrl)});
            process.stdout.write('second-saving\\n');
            try {
                await trySaveChat(
                    ${JSON.stringify(secondPayload)},
                    ${JSON.stringify(chatFile)},
                    false,
                    'second-process',
                    'Test Card',
                    ${JSON.stringify(backupDirectory)},
                    { deferBackup: true },
                );
                process.stdout.write('second-saved\\n');
            } catch (error) {
                process.stdout.write('second-rejected:' + error.message + '\\n');
            }
        `;
        const second = spawn(process.execPath, ['--input-type=module', '-e', secondScript], {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let secondOutput = '';
        second.stdout.setEncoding('utf8');
        second.stdout.on('data', chunk => secondOutput += chunk);
        const secondExit = waitForChildExit(second);
        await waitForOutput(second, 'second-contended');

        fs.writeFileSync(releasePath, 'release');
        await Promise.all([firstExit, secondExit]);

        expect(firstOutput).toContain('first-saved');
        expect(secondOutput).toMatch(/second-rejected:.*integrity/i);
        expect(secondOutput).not.toContain('second-saved');
        expect(fs.readFileSync(chatFile, 'utf8')).toContain('first writer');
    });
});

function createChat(integrity, message) {
    return [
        {
            chat_metadata: { integrity },
            user_name: 'unused',
            character_name: 'unused',
        },
        {
            name: 'User',
            is_user: true,
            send_date: '2026-06-06T00:00:00.000Z',
            mes: message,
        },
    ];
}

function waitForOutput(child, expected) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (stdout.includes(expected)) {
                resolve();
            }
        });
        child.stderr.on('data', chunk => stderr += chunk);
        child.once('error', reject);
        child.once('exit', (code) => {
            if (!stdout.includes(expected)) {
                reject(new Error(`Lock holder exited with code ${code}: ${stderr}`));
            }
        });
    });
}

function waitForChildExit(child) {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Lock holder exited with code ${code}.`)));
    });
}
