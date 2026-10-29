import { afterEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    auditCssSource,
    auditFrontendContracts,
    extractHtmlAssetReferences,
    compareAuditBaseline,
} from '../scripts/audit-frontend-contracts.js';

const temporaryRoots = [];
afterEach(() => temporaryRoots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture(html = '', css = '') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-audit-'));
    temporaryRoots.push(root);
    fs.mkdirSync(path.join(root, 'public/css'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public/index.html'), html);
    fs.writeFileSync(path.join(root, 'public/login.html'), '');
    for (const name of ['sillybunny-theme', 'sillybunny-tabs', 'sillybunny-mobile-shell']) fs.writeFileSync(path.join(root, `public/css/${name}.css`), css);
    return root;
}

function cli(root, ...args) {
    return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/audit-frontend-contracts.js', import.meta.url)), '--root', root, ...args], { encoding: 'utf8' });
}

describe('frontend contract audit', () => {
    test('finds local HTML assets without treating external URLs as local files', () => {
        const references = extractHtmlAssetReferences(`
            <link rel="stylesheet" href="css/app.css?v=1">
            <script src="scripts/app.js"></script>
            <link rel="stylesheet" href="https://example.test/app.css">
        `);

        expect(references).toEqual([
            expect.objectContaining({ attribute: 'href', value: 'css/app.css?v=1' }),
            expect.objectContaining({ attribute: 'src', value: 'scripts/app.js' }),
        ]);
    });

    test('reports CSS parse failures and unguarded motion separately', () => {
        const invalid = auditCssSource('.broken { color red; }', 'fixture.css');
        expect(invalid.parseError).toBeDefined();

        const motion = auditCssSource('.panel { transition: opacity 180ms ease-out; }', 'fixture.css');
        expect(motion.unguardedMotion).toContain('transition: .panel');
    });

    test('does not treat transition configuration properties as timed motion', () => {
        const audit = auditCssSource('.panel { transition: none !important; transition-property: none !important; transition-behavior: normal !important; }', 'fixture.css');
        expect(audit.unguardedMotion).toEqual([]);
    });

    test('recognizes WebKit companions and reduced-motion overrides', () => {
        const source = `
            .panel {
                -webkit-backdrop-filter: blur(8px);
                backdrop-filter: blur(8px);
                transition: opacity 180ms ease-out;
            }

            @media (prefers-reduced-motion: reduce) {
                .panel { transition: none; }
            }
        `;

        const audit = auditCssSource(source, 'fixture.css');
        expect(audit.compatibilityFindings).toEqual([]);
        expect(audit.unguardedMotion).toEqual([]);
    });

    test('reports missing WebKit companions for compatibility-sensitive declarations', () => {
        const audit = auditCssSource(`
            .panel {
                user-select: none;
                position: sticky;
            }
        `, 'fixture.css');

        expect(audit.compatibilityFindings.map(finding => finding.code)).toEqual([
            'missing-webkit-user-select',
            'missing-webkit-sticky-position',
        ]);
    });

    test('audits the repository baseline without hard failures', () => {
        const findings = auditFrontendContracts();

        expect(findings.filter(finding => finding.severity === 'error')).toEqual([]);
    });

    test('reads actual attributes, mixed case, entities and unquoted values without scanning raw text', () => {
        const html = `<!-- <script src="missing.js"></script> -->
            <SCRIPT SRC=app.js data-note=">" data-id="same">const text = '<div id="same"><script src="fake.js">';</SCRIPT>
            <style>.x { content: '<b id="same">'; }</style><textarea><b id="same"></textarea>
            <div data-id="same" title='id="same"' id=unique></div>
            <LINK HREF="css/a.css?a=1&amp;b=2"><div ID="s&#97;me"></div><b id=same></b>`;
        expect(extractHtmlAssetReferences(html).map(item => item.value)).toEqual(['app.js', 'css/a.css?a=1&b=2']);
        const findings = auditFrontendContracts({ repoRoot: fixture(html) });
        expect(findings.filter(item => item.code === 'duplicate-id')).toEqual([expect.objectContaining({ count: 1, message: expect.stringContaining('id="same"') })]);
    });

    test('resolves nested, absolute and encoded assets and rejects missing files, directories and escapes', () => {
        const root = fixture('<script src="css/missing.js"></script><script src="%2e%2e/private.js"></script><link href="%zz"><link href="css/">');
        const findings = auditFrontendContracts({ repoRoot: root });
        expect(findings.map(item => item.code)).toEqual(['missing-asset', 'asset-path-escape', 'invalid-asset-url', 'missing-asset']);
        fs.mkdirSync(path.join(root, 'public/nested'));
        fs.writeFileSync(path.join(root, 'public/nested/page.html'), '<link href="../css/sillybunny-theme.css"><link href="/css/sillybunny-tabs.css">');
        expect(auditFrontendContracts({ repoRoot: root, targets: { html: ['public/nested/page.html'] } })).toEqual([]);
    });

    test('recognizes zero-duration universal guards across sheets, including pseudo-elements', () => {
        const root = fixture();
        fs.writeFileSync(path.join(root, 'public/css/sillybunny-theme.css'), '@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; } }');
        fs.writeFileSync(path.join(root, 'public/css/sillybunny-tabs.css'), '.panel { transition: opacity 180ms 1s; } .panel::before { animation: reveal 240ms; }');
        expect(auditFrontendContracts({ repoRoot: root })).toEqual([]);
    });

    for (const guard of [
        '@media (max-width: 768px) and (prefers-reduced-motion: reduce) { .panel { transition: none; } }',
        '@media not (prefers-reduced-motion: reduce) { .panel { transition: none; } }',
        '@media (prefers-reduced-motion: reduce), (hover: hover) { .panel { transition: none; } }',
        '@media (prefers-reduced-motion: reduce) { .panel { transition-duration: 0s; } }',
    ]) {
        test(`does not accept conditional or incomplete guards: ${guard}`, () => {
            expect(auditCssSource(`.panel { transition: opacity 180ms 1s; } ${guard}`).unguardedMotion).toHaveLength(1);
        });
    }

    test('a later declaration or important motion cannot be hidden by a weaker guard', () => {
        expect(auditCssSource('@media (prefers-reduced-motion: reduce) { .panel { transition: none; } } .panel { transition: opacity 180ms; }').unguardedMotion).toHaveLength(1);
        expect(auditCssSource('.panel { transition: opacity 180ms !important; } @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }').unguardedMotion).toHaveLength(1);
    });

    test('baseline comparison detects new, increased and resolved debt without line-number coupling', () => {
        const root = fixture('<b id=x></b><b id=x></b>');
        const findings = auditFrontendContracts({ repoRoot: root });
        const baseline = { version: 1, warnings: findings.map(({ key, count }) => ({ key, count })) };
        fs.writeFileSync(path.join(root, 'public/index.html'), '\n\n<b id=x></b><b id=x></b>');
        expect(compareAuditBaseline(auditFrontendContracts({ repoRoot: root }), baseline)).toEqual({ regressions: [], resolved: [] });
        expect(compareAuditBaseline([{ ...findings[0], count: 2 }], baseline).regressions).toHaveLength(1);
        expect(compareAuditBaseline([], baseline).resolved).toHaveLength(1);
        expect(() => compareAuditBaseline(findings, { version: 1, warnings: [{ key: 'x', count: 0 }] })).toThrow('Invalid');
    });

    test('CLI reports JSON, checks baselines, enforces strict mode and rejects invalid arguments', () => {
        const root = fixture('<b id=x></b><b id=x></b>');
        const result = cli(root, '--json');
        expect(result.status).toBe(0);
        const { findings } = JSON.parse(result.stdout);
        expect(cli(root, '--strict').status).toBe(1);
        const baselinePath = path.join(root, 'baseline.json');
        fs.writeFileSync(baselinePath, JSON.stringify({ version: 1, warnings: findings.map(({ key, count }) => ({ key, count })) }));
        expect(cli(root, '--baseline', baselinePath).status).toBe(0);
        expect(cli(root, '--unknown').status).toBe(1);
        expect(cli(root, '--baseline').status).toBe(1);
        fs.writeFileSync(path.join(root, 'public/index.html'), '<script src="missing.js"></script>');
        expect(cli(root).status).toBe(1);
        expect(cli(root, '--baseline', baselinePath).status).toBe(1);
    });
});
