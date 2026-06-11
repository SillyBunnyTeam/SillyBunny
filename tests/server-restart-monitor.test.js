import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { getServerBootId } from '../src/server-boot-marker.js';
import { hasServerReturnedAfterRestart } from '../public/scripts/server-restart-monitor.js';

const repoRoot = path.resolve(process.cwd(), '..');

describe('server restart monitor', () => {
    test('recognizes restart completion from a changed server boot marker', () => {
        expect(hasServerReturnedAfterRestart({ serverBootId: 'next' }, { previousServerBootId: 'previous' })).toBe(true);
        expect(hasServerReturnedAfterRestart({ serverBootId: 'same' }, { previousServerBootId: 'same' })).toBe(false);
    });

    test('keeps existing revision, version, and offline fallback checks', () => {
        expect(hasServerReturnedAfterRestart({ gitRevision: 'abc' }, { expectedRevision: 'abc' })).toBe(true);
        expect(hasServerReturnedAfterRestart({ pkgVersion: '1.2.3' }, { expectedVersion: '1.2.3' })).toBe(true);
        expect(hasServerReturnedAfterRestart({}, { sawOffline: true })).toBe(true);
        expect(hasServerReturnedAfterRestart({ gitRevision: 'old', pkgVersion: '1.2.2' }, {
            expectedRevision: 'new',
            expectedVersion: '1.2.3',
        })).toBe(false);
    });

    test('exposes a stable non-empty boot marker for the current process', () => {
        const bootId = getServerBootId();

        expect(bootId).toEqual(expect.any(String));
        expect(bootId.length).toBeGreaterThan(8);
        expect(getServerBootId()).toBe(bootId);
    });

    test('wires the boot marker through version and restart responses', () => {
        const serverMainSource = fs.readFileSync(path.join(repoRoot, 'src', 'server-main.js'), 'utf8');
        const serverAdminSource = fs.readFileSync(path.join(repoRoot, 'src', 'endpoints', 'server-admin.js'), 'utf8');
        const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

        expect(serverMainSource).toContain('serverBootId: getServerBootId()');
        expect(serverAdminSource).toContain('serverBootId: getServerBootId()');
        expect(tabsSource).toContain("waitForServerReturn('', { previousServerBootId: result?.serverBootId })");
    });
});
