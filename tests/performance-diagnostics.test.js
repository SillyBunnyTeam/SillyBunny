import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    getPerformanceDiagnosticsUrl,
    sanitizeLocation,
    sanitizeUrlForReport,
    serializeDiagnosticValue,
    summarizePerformanceResources,
} from '../public/scripts/extensions/performance-diagnostics/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('browser performance diagnostics helpers', () => {
    test('sanitizes location details without query values', () => {
        expect(sanitizeLocation({
            origin: 'https://example.test',
            pathname: '/chat',
            search: '?token=secret&performance-diagnostics=1',
            hash: '#performance-logging/debug/token=secret',
        })).toEqual({
            origin: 'https://example.test',
            pathname: '/chat',
            queryKeys: ['performance-diagnostics', 'token'],
            hashFlags: ['debug', 'performance-logging', 'token=[redacted]'],
        });
    });

    test('summarizes resource timing bytes by transfer and body sizes', () => {
        expect(summarizePerformanceResources([
            {
                name: 'https://example.test/script.js',
                transferSize: 0,
                encodedBodySize: 120,
                decodedBodySize: 240,
            },
            {
                name: 'https://example.test/style.css',
                transferSize: 30,
                encodedBodySize: 40,
                decodedBodySize: 80,
            },
        ])).toEqual({
            transfer: {
                count: 2,
                js: 0,
                css: 30,
                font: 0,
                image: 0,
                other: 0,
            },
            encoded: {
                count: 2,
                js: 120,
                css: 40,
                font: 0,
                image: 0,
                other: 0,
            },
            decoded: {
                count: 2,
                js: 240,
                css: 80,
                font: 0,
                image: 0,
                other: 0,
            },
            zeroTransferCount: 1,
            zeroTransferWithEncodedBodyCount: 1,
        });
    });

    test('sanitizes resource URLs without query values', () => {
        expect(sanitizeUrlForReport('https://example.test/script.js?token=secret&foo=bar')).toEqual({
            origin: 'cross-origin',
            protocol: 'https:',
            pathname: '/script.js',
            queryKeys: ['foo', 'token'],
        });
    });

    test('serializes circular and long diagnostic values safely', () => {
        const value = {
            longText: 'x'.repeat(600),
        };
        value.self = value;

        const serialized = serializeDiagnosticValue(value);

        expect(serialized.longText).toHaveLength(503);
        expect(serialized.longText.endsWith('...')).toBe(true);
        expect(serialized.self).toBe('[circular]');

        const serializedError = serializeDiagnosticValue(new Error('token=secret'));
        expect(serializedError.message).toBe('token=[redacted]');

        expect(serializeDiagnosticValue({ access_token: 'secret', password: 'secret' })).toEqual({
            access_token: '[redacted]',
            password: '[redacted]',
        });
    });

    test('creates a diagnostics URL without dropping existing params', () => {
        expect(getPerformanceDiagnosticsUrl('https://example.test/?foo=1#section'))
            .toBe('https://example.test/?foo=1&performance-diagnostics=1#section');
    });

    test('base startup files do not load diagnostics directly', () => {
        const script = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
        const index = fs.readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
        const powerUser = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'power-user.js'), 'utf8');

        expect(script).not.toContain('performance-diagnostics');
        expect(script).not.toContain('SillyBunnyPerformanceDiagnostics');
        expect(index).not.toContain('performance-diagnostics');
        expect(index).not.toContain('performance.setResourceTimingBufferSize?.(2000)');
        expect(powerUser).not.toContain('performance-diagnostics');
    });

    test('diagnostics are packaged as a toggleable built-in extension', () => {
        const extensionRoot = path.join(repoRoot, 'public', 'scripts', 'extensions', 'performance-diagnostics');
        const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
        const script = fs.readFileSync(path.join(extensionRoot, 'index.js'), 'utf8');

        expect(manifest).toEqual(expect.objectContaining({
            js: 'index.js',
            css: 'style.css',
            bundled_opt_in: true,
            hooks: expect.objectContaining({
                activate: 'init',
                disable: 'disable',
            }),
        }));
        expect(script).toContain('export function init()');
        expect(script).toContain('export function disable()');
        expect(script).toContain('SillyBunnyPerformanceDiagnostics');
        expect(JSON.stringify(manifest)).not.toContain('lorum ipsum');
        expect(script).not.toContain('lorum ipsum');
    });
});
