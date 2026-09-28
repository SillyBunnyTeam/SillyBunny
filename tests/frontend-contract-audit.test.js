import { describe, expect, test } from '@jest/globals';
import {
    auditCssSource,
    auditFrontendContracts,
    extractHtmlAssetReferences,
} from '../scripts/audit-frontend-contracts.js';

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
});
