import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExtensionScriptLoadError, formatExtensionLoadError } from '../public/scripts/extension-load-errors.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('extension load error diagnostics', () => {
    test('wraps script load events with extension and script details', () => {
        const event = { type: 'error', target: { src: 'https://example.test/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1' } };
        const error = createExtensionScriptLoadError('third-party/Extension-WebSearch', '/fallback.js', event);

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Could not load extension script for "third-party/Extension-WebSearch": https://example.test/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1');
        expect(error.cause).toBe(event);
        expect(error.extensionName).toBe('third-party/Extension-WebSearch');
        expect(error.extensionScriptUrl).toBe('https://example.test/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1');
    });

    test('formats raw browser events without object Object output', () => {
        expect(formatExtensionLoadError({ type: 'error', target: { src: '/scripts/extensions/third-party/Extension-WebSearch/index.js?v=1' } }))
            .toBe('Load failed for /scripts/extensions/third-party/Extension-WebSearch/index.js?v=1');

        expect(formatExtensionLoadError({ type: 'error' })).toBe('Load failed (error)');
    });

    test('preserves useful error and object messages', () => {
        expect(formatExtensionLoadError(new Error('Extension context is not available yet.'))).toBe('Extension context is not available yet.');
        expect(formatExtensionLoadError({ message: 'WebSearch failed during module evaluation' })).toBe('WebSearch failed during module evaluation');
        expect(formatExtensionLoadError({ reason: new Error('SillyTavern.getContext is not ready') })).toBe('SillyTavern.getContext is not ready');
        expect(formatExtensionLoadError({ code: 'ERR_WEBSEARCH', extension: 'WebSearch' })).toBe('{"code":"ERR_WEBSEARCH","extension":"WebSearch"}');
        expect(formatExtensionLoadError({})).toBe('Unknown extension load error');
    });

    test('wires diagnostics into extension activation and script loading', () => {
        const extensionsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions.js'), 'utf8');

        expect(extensionsSource).toContain("import { createExtensionScriptLoadError, formatExtensionLoadError } from './extension-load-errors.js';");
        expect(extensionsSource).toContain('const loadError = formatExtensionLoadError(err);');
        expect(extensionsSource).toContain('extensionLoadErrors.add(t`Extension "${displayName}" failed to load: ${loadError}`);');
        expect(extensionsSource).toContain('reject(createExtensionScriptLoadError(name, url, err));');
    });
});
