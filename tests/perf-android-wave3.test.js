import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerSource = fs.readFileSync(path.join(repoRoot, 'scripts', 'bootstrap', 'install.sh'), 'utf8');

describe('Android Wave 3: install.sh clone flags, baseline profile, and R8 rules', () => {
    test('install.sh Android clone passes --no-tags while keeping --no-single-branch for branch switching', () => {
        expect(installerSource).toContain(
            'git -c advice.detachedHead=false clone --no-single-branch --no-tags --depth 1 --filter=blob:none --no-checkout --branch "$ref" -- "$repo" "$install_dir"',
        );
        // Desktop clone branch remains untouched.
        expect(installerSource).toContain(
            'git -c advice.detachedHead=false clone --filter=blob:none --branch "$ref" -- "$repo" "$install_dir"',
        );
    });

    test('baseline-prof.txt covers SillyBunny cold-start classes with valid HRF rules and no dead descriptors', () => {
        const profPath = path.join(repoRoot, 'android', 'app', 'src', 'main', 'baseline-prof.txt');
        const lines = fs.readFileSync(profPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        const ruleLines = lines.filter(l => !l.startsWith('#'));
        expect(ruleLines.length).toBeGreaterThan(30);

        const methodRules = ruleLines.filter(l => /^[HSP]+L/.test(l));
        const classRules = ruleLines.filter(l => !/^[HSP]+L/.test(l));
        expect(methodRules.length).toBeGreaterThan(15);
        expect(classRules.length).toBeGreaterThan(15);
        for (const line of methodRules) {
            expect(line).toContain('->');
        }
        for (const line of classRules) {
            expect(line.startsWith('L')).toBe(true);
            expect(line.endsWith(';')).toBe(true);
        }
        const joined = ruleLines.join('\n');
        for (const required of [
            'MainActivity',
            'ServerService',
            'ServerManager',
            'RuntimeLayout',
            'RuntimeLayoutInstaller',
            'InstallScriptLayout',
            'WebShell',
            'WebScreenKt',
            'StaticAssetInterceptor',
            'ProcessEnvironment',
            'SessionProcess',
            'AppUpdater',
            'DataRoot',
            'PathContainment',
            'CheckoutChecks',
        ]) {
            expect(joined).toContain(required);
        }
        for (const dead of [
            'SillyBunnyApplication',
            'web/WebScreen;',
            'repair/RepairChecks;',
            'androidx/webkit/WebViewAssetLoader',
        ]) {
            expect(joined).not.toContain(dead);
        }
    });

    test('R8 keeps original source filenames and app explicitly declares profileinstaller', () => {
        const proguard = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'proguard-rules.pro'), 'utf8');
        expect(proguard).toContain('-keepattributes SourceFile,LineNumberTable');
        expect(proguard).not.toContain('-renamesourcefileattribute');

        const buildGradle = fs.readFileSync(path.join(repoRoot, 'android', 'app', 'build.gradle.kts'), 'utf8');
        expect(buildGradle).toContain('implementation(libs.androidx.profileinstaller)');
    });
});
