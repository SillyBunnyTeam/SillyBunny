import { describe, expect, test } from '@jest/globals';

import { extractMergedPrNumbers, updateChangelog } from '../scripts/update-changelog-merged-prs.js';

describe('update changelog merged PR extraction', () => {
    test('extracts classic merge commit pull request numbers', () => {
        expect(extractMergedPrNumbers('Merge pull request #305 from owner/branch')).toEqual(['305']);
    });

    test('extracts squash merge pull request numbers from commit subjects', () => {
        expect(extractMergedPrNumbers('fix: close release readiness regressions (#306)')).toEqual(['306']);
    });

    test('ignores pull-request-shaped references outside the subject line', () => {
        expect(extractMergedPrNumbers('fix: release polish\n\nRefs cleanup note (#999)')).toEqual([]);
    });

    test('deduplicates pull request numbers found through multiple merge styles', () => {
        expect(extractMergedPrNumbers('Merge pull request #306 from owner/branch\nfix: close release readiness regressions (#306)')).toEqual(['306']);
    });
});

describe('update changelog merged PR entries', () => {
    const mergedPr = {
        number: 321,
        title: 'fix: unblock changelog sync',
        mergedAt: '2026-06-04T12:34:56Z',
    };

    test('creates a missing package version section at the top of the changelog', () => {
        const changelog = '# Changelog\n\n## v1.6.2\n\n### Fixed\n- Existing entry.\n';

        expect(updateChangelog(changelog, 'v1.6.4', [mergedPr])).toBe(
            '# Changelog\n\n## v1.6.4\n\n### Merged Staging PRs\n- PR #321 (2026-06-04) `fix: unblock changelog sync`\n\n## v1.6.2\n\n### Fixed\n- Existing entry.\n',
        );
    });
});
