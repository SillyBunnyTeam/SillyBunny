import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions.js'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = extensionsSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = extensionsSource.indexOf('{', start);
    let depth = 0;

    for (let index = bodyStart; index < extensionsSource.length; index++) {
        const char = extensionsSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return extensionsSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('extension boot lifecycle wiring', () => {
    test('imports extension boot lifecycle decisions into extension runtime', () => {
        expect(extensionsSource).toContain('EXTENSION_BOOT_ACTIVATION_ACTION');
        expect(extensionsSource).toContain('normalizeExtensionBootId');
        expect(extensionsSource).toContain('resolveExtensionActivationState');
        expect(extensionsSource).toContain('resolveExtensionManifestRegistration');
        expect(extensionsSource).toContain('sortExtensionBootEntries');
    });

    test('routes extension dedupe keys through the lifecycle helper', () => {
        const source = getFunctionSource('getExtensionDedupKey');

        expect(source).toContain('return normalizeExtensionBootId(name);');
        expect(source).not.toContain('replace(/^third-party');
    });

    test('routes manifest duplicate registration through the lifecycle helper', () => {
        const source = getFunctionSource('getManifests');

        expect(source).toContain('resolveExtensionManifestRegistration({');
        expect(source).toContain('name: result.name');
        expect(source).toContain('existingKeys: loadedManifestKeys');
        expect(source).toContain('registrationState.shouldRegister');
        expect(source).toContain('loadedManifestKeys.add(registrationState.dedupeKey)');
    });

    test('routes activation ordering and eligibility through the lifecycle helper', () => {
        const source = getFunctionSource('activateExtensions');

        expect(source).toContain('sortExtensionBootEntries(Object.entries(manifests))');
        expect(source).toContain('resolveExtensionActivationState({');
        expect(source).toContain('availableModules: modules');
        expect(source).toContain('availableExtensionNames: extensionNames');
        expect(source).toContain('disabledDependencyNames');
        expect(source).toContain('clientVersionMeetsMinimum');
        expect(source).toContain('activationState.shouldSkip');
        expect(source).toContain('activationState.shouldActivate');
        expect(source).toContain('activationState.shouldWaitForDependencyActivations');
    });

    test('loads extension modules by a URL with no query', () => {
        for (const name of ['addExtensionScript', 'callExtensionHook']) {
            const source = getFunctionSource(name);

            expect(source).toContain('buildExtensionModuleUrl(name, manifest.js)');
            expect(source).not.toContain('getExtensionAssetUrl(');
        }
    });

    test('gives other extension assets a version query and hints scripts by their module URL', () => {
        expect(getFunctionSource('getExtensionAssetUrl')).toContain('buildExtensionAssetUrl(name, assetPath, CLIENT_VERSION)');
        expect(getFunctionSource('addExtensionStyle')).toContain('getExtensionAssetUrl(name, manifest.css)');
        expect(getFunctionSource('addExtensionLocale')).toContain('getExtensionAssetUrl(name, localeFile)');
        expect(getFunctionSource('prefetchExtensionAsset')).toContain('as === \'script\' ? buildExtensionModuleUrl(name, assetPath)');
    });

    test('routes activation warnings through lifecycle action names', () => {
        const source = getFunctionSource('activateExtensions');

        expect(source).toContain('activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.MISSING_MODULES');
        expect(source).toContain('activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.DISABLED_DEPENDENCIES');
        expect(source).toContain('activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.MISSING_DEPENDENCIES');
        expect(source).toContain('activationState.action === EXTENSION_BOOT_ACTIVATION_ACTION.CLIENT_VERSION_UNSUPPORTED');
        expect(source).toContain('activationState.missingModules.join');
        expect(source).toContain('activationState.disabledDependencies.join');
        expect(source).toContain('activationState.missingDependencies.join');
        expect(source).not.toContain('let meetsModuleRequirements = true');
        expect(source).not.toContain('let meetsExtensionDeps = true');
    });
});
