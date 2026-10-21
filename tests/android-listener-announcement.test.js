/* eslint-disable playwright/no-standalone-expect -- Jest test.each tables are not Playwright tests. */
import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Android app sends the launch token to 127.0.0.1:<port> only after the server announces its listener on
// stdout (android/app/src/main/java/io/github/sillybunnyteam/sillybunny/server/ListenerAnnouncement.kt). If the
// announcement changes shape, the app waits in Starting until its startup timeout, so these checks pin it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const KOTLIN_ANSI = String.raw`"\u001B\\[[0-?]*[ -/]*[@-~]"`;
const KOTLIN_ANNOUNCEMENT = String.raw`"""\bis listening on\b.*\bIPv4: 127\.0\.0\.1:(\d{1,5})(?=\s|$)"""`;
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANNOUNCEMENT = /\bis listening on\b.*\bIPv4: 127\.0\.0\.1:(\d{1,5})(?=\s|$)/;

describe('Android listener announcement', () => {
    test('the app matches the expressions this test uses', () => {
        const kotlin = read('android/app/src/main/java/io/github/sillybunnyteam/sillybunny/server/ListenerAnnouncement.kt');
        expect(kotlin).toContain(KOTLIN_ANSI);
        expect(kotlin).toContain(KOTLIN_ANNOUNCEMENT);
    });

    test('the server prints the IPv4 listen host after "is listening on"', () => {
        const server = read('src/server-main.js');
        expect(server).toContain('let logListen = `${APP_NAME} is listening on`;');
        expect(server).toContain('\' IPv4: \' + cliArgs.getIPv4ListenUrl().host');
        expect(server).toContain('console.log(logListen);');
    });

    test('a loopback-only server listens on 127.0.0.1', () => {
        // The app sets SILLYTAVERN_LISTEN=false, so the IPv4 listen URL is always the loopback address.
        expect(read('src/command-line.js')).toContain('(this.listen ? (isValid ? this.listenAddressIPv4 : \'0.0.0.0\') : \'127.0.0.1\')');
    });

    test.each([
        ['\u001B[32m IPv6: [::1]:8123\u001B[39m\u001B[32m IPv4: 127.0.0.1:8123\u001B[39m', '8123'],
        ['\u001B[32m IPv4: 127.0.0.1:8123\u001B[39m', '8123'],
    ])('the printed line names the session port: %j', (hosts, port) => {
        const line = `SillyBunny is listening on${hosts}`;
        expect(line.replace(ANSI, '').match(ANNOUNCEMENT)?.[1]).toBe(port);
    });
});
