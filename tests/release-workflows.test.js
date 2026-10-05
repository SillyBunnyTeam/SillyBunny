import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

const repoRoot = path.resolve(process.cwd(), '..');
const readWorkflow = name => readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8');

describe('release pipeline workflows', () => {
    test('draft release is tag-triggered, verified against package.json, and never publishes', () => {
        const source = readWorkflow('release.yml');
        expect(source).toContain('- \'v[0-9]+.[0-9]+.[0-9]+\'');
        expect(source).toContain('- \'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+\'');
        expect(source).toContain('node scripts/bump-version.js --check');
        expect(source).toContain('--draft --verify-tag --generate-notes');
        expect(source).toContain('Release candidate $TAG must be tagged on staging or release.');
        expect(source).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/release');
        // The approval gate sits on publishing (docker-publish.yml), not on drafting.
        expect(source).not.toContain('environment:');
    });

    test('prepare-release branches from staging into a release/v* branch that pr-metadata accepts', () => {
        const source = readWorkflow('prepare-release.yml');
        const prMetadata = readWorkflow('pr-metadata.yml');
        expect(source).toContain('ref: staging');
        expect(source).toContain('echo "branch=release/v$version"');
        expect(source).toContain('--base release');
        expect(source).toContain('--title "chore: release v$VERSION"');
        expect(prMetadata).toContain('release/v* | hotfix/* | rollback/v*');
    });

    test('post-release stacks the -dev bump on the back-merge and skips prereleases', () => {
        const source = readWorkflow('post-release.yml');
        expect(source).toContain('if: ${{ !github.event.release.prerelease }}');
        const merge = source.indexOf('git merge --no-ff');
        const bump = source.indexOf('node scripts/bump-version.js');
        expect(merge).toBeGreaterThan(-1);
        expect(bump).toBeGreaterThan(merge);
        expect(source).toContain('gh pr create --base staging --head release');
        expect(source).toContain('sort -V');
    });

    test('docker publishing gates release images behind the release environment', () => {
        const source = readWorkflow('docker-publish.yml');
        const releaseJob = source.slice(source.indexOf('publish-release:'), source.indexOf('publish-staging:'));
        const stagingJob = source.slice(source.indexOf('publish-staging:'));
        expect(releaseJob).toContain('environment: release');
        expect(releaseJob).toContain('type=raw,value=latest,enable=${{ !github.event.release.prerelease }}');
        expect(stagingJob).not.toContain('environment:');
        expect(stagingJob).toContain('type=raw,value=staging');
        expect(source).toContain('platforms: linux/amd64,linux/arm64');
    });

    test('release-e2e runs on every PR into release so it can be a required check', () => {
        const source = readWorkflow('release-e2e.yml');
        const pullRequestBlock = source.slice(source.indexOf('  pull_request:'), source.indexOf('  push:'));
        expect(pullRequestBlock).toContain('- release');
        expect(pullRequestBlock).not.toContain('paths-ignore');
    });

    test('every third-party action in the new workflows is pinned to a full commit SHA', () => {
        for (const name of ['release.yml', 'prepare-release.yml', 'post-release.yml', 'docker-publish.yml', 'release-checks.yml']) {
            const uses = [...readWorkflow(name).matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
            expect(uses.length).toBeGreaterThan(0);
            for (const reference of uses) {
                expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
            }
        }
    });
});
