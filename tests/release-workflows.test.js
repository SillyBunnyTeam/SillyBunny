import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { parse } from 'yaml';

import { attachUpdateManifest } from '../android/release/attach-update-manifest.mjs';
import { stagedRuntimeProblems } from '../android/release/check-staged-runtime.mjs';
import { ReleaseToolError, UsageError } from '../android/release/common.mjs';
import { decideRelease } from '../android/release/release-decision.mjs';

// Step scripts and CLIs run as child processes, which are slow on Windows.
jest.setTimeout(60_000);

const repoRoot = path.resolve(process.cwd(), '..');
const readWorkflow = name => readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8');
const readRepoFile = name => readFileSync(path.join(repoRoot, ...name.split('/')), 'utf8');

describe('release pipeline workflows', () => {
    test('draft release is tag-triggered, verified against package.json, and never publishes', () => {
        const source = readWorkflow('release.yml');
        expect(source).toContain('- \'v[0-9]+.[0-9]+.[0-9]+\'');
        expect(source).toContain('- \'v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+\'');
        expect(source).toContain('node scripts/bump-version.js --check');
        expect(source).toContain('--draft --verify-tag --generate-notes');
        expect(source).toContain('Release candidate $TAG must be tagged on staging or release.');
        expect(source).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/release');
        // The approval gate sits on publishing (docker-publish.yml), not on drafting. The one exception is the
        // Android signing job's environment (plan §6.3, §9.9), which the Android tests below pin to that job.
        expect(source.match(/^\s*environment:.*$/gm)).toEqual(['    environment: android-signing']);
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
        // The one local reference: release.yml's job-level call of the shared Android smoke (plan §6.2, §9.9).
        for (const [name, local] of [
            ['release.yml', [ANDROID_SMOKE]],
            ['prepare-release.yml', []],
            ['post-release.yml', []],
            ['docker-publish.yml', []],
            ['release-checks.yml', []],
        ]) {
            const uses = [...readWorkflow(name).matchAll(/^\s*(?:- )?uses:\s*([^\s#]+)/gm)].map(match => match[1]);
            expect(uses.length).toBeGreaterThan(0);
            expect(uses.filter(reference => !/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(reference))).toEqual(local);
        }
        const jobs = parse(readWorkflow('release.yml')).jobs;
        expect(Object.values(jobs).map(job => job.uses).filter(Boolean)).toEqual([ANDROID_SMOKE]);
        expect(Object.values(jobs).flatMap(job => job.steps ?? []).map(step => step.uses).filter(Boolean)
            .every(reference => /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(reference))).toBe(true);
    });
});

const ANDROID_SMOKE = './.github/workflows/android-smoke.yml';
const SIGNING_SECRETS = ['ANDROID_KEYSTORE_B64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
const ERROR_ANNOTATION = '::error title=TODO(copy)::TODO(copy)';
const SIGNER = 'a6f296b190227ca0f0f6327ef06f3705f026a81562b10def548addb0f668e0f3';
const HASH_A = 'a1'.repeat(32);
const HASH_B = 'b2'.repeat(32);
const describePosix = process.platform === 'win32' ? describe.skip : describe;

const releaseSource = readWorkflow('release.yml');
const release = parse(releaseSource);
const jobs = release.jobs;
const needsOf = job => [job.needs ?? []].flat();
const stepNamed = (job, name) => job.steps.find(step => step.name === name);
const stepIndex = (job, name) => job.steps.findIndex(step => step.name === name);

describe('Android APK release jobs (plan §6.1-§6.3)', () => {
    test('the job graph decides, builds or re-attaches, runs the smoke, signs, then drafts', () => {
        expect(Object.keys(jobs)).toEqual(['decide', 'android-build', 'android-smoke', 'android-sign', 'android-reattach', 'draft-release']);
        expect(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, needsOf(job)]))).toEqual({
            'decide': [],
            'android-build': ['decide'],
            'android-smoke': ['decide'],
            'android-sign': ['decide', 'android-build', 'android-smoke'],
            'android-reattach': ['decide', 'android-smoke'],
            'draft-release': ['decide', 'android-build', 'android-smoke', 'android-sign', 'android-reattach'],
        });
        expect(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job.if]))).toEqual({
            'decide': undefined,
            'android-build': 'needs.decide.outputs.android == \'build\'',
            'android-smoke': 'needs.decide.outputs.android == \'build\' || needs.decide.outputs.android == \'reattach\'',
            // A release never signs or re-attaches APKs whose smoke was skipped.
            'android-sign': 'needs.decide.outputs.android == \'build\' && needs.android-smoke.outputs.outcome == \'passed\'',
            'android-reattach': 'needs.decide.outputs.android == \'reattach\' && needs.android-smoke.outputs.outcome == \'passed\'',
            'draft-release': '${{ !cancelled() && needs.decide.result == \'success\' }}',
        });
        expect(jobs.decide.outputs).toEqual({
            'prerelease': '${{ steps.tag.outputs.prerelease }}',
            'android': '${{ steps.android.outputs.action }}',
            'default-ref': '${{ steps.android.outputs.default-ref }}',
            'inputs-hash': '${{ steps.android.outputs.inputs-hash }}',
            'previous-tag': '${{ steps.android.outputs.previous-tag }}',
        });
        // Tag validation moved into decide unchanged, so nothing downstream runs for a bad tag.
        expect(stepIndex(jobs.decide, 'Validate tag')).toBeLessThan(stepIndex(jobs.decide, 'Decide the Android APKs'));
        expect(jobs['draft-release'].steps.some(step => step.id === 'tag')).toBe(false);
    });

    test('each job has least-privilege permissions', () => {
        expect(release.permissions).toEqual({ contents: 'read' });
        expect(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job.permissions]))).toEqual({
            // Draft releases are listed only to a token with push access, and the versionCode rule counts them.
            'decide': { 'contents': 'write' },
            'android-build': { 'contents': 'read' },
            'android-smoke': { 'contents': 'read' },
            'android-sign': { 'contents': 'read' },
            'android-reattach': { 'contents': 'read' },
            'draft-release': { 'contents': 'write', 'id-token': 'write', 'attestations': 'write' },
        });
    });

    test('every job has a realistic timeout except the reusable-workflow call, where GitHub forbids one', () => {
        expect(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job['timeout-minutes']]))).toEqual({
            'decide': 15,
            'android-build': 120,
            'android-smoke': undefined,
            'android-sign': 20,
            'android-reattach': 20,
            'draft-release': 30,
        });
    });

    test('the smoke is the shared android-smoke.yml, called with the decided default-ref and nothing else', () => {
        expect(jobs['android-smoke']).toEqual({
            'needs': 'decide',
            'if': 'needs.decide.outputs.android == \'build\' || needs.decide.outputs.android == \'reattach\'',
            'permissions': { contents: 'read' },
            'uses': ANDROID_SMOKE,
            'with': { 'default-ref': '${{ needs.decide.outputs.default-ref }}' },
        });
        const smoke = parse(readWorkflow('android-smoke.yml'));
        expect(Object.keys(smoke.on)).toEqual(['workflow_call']);
        expect(Object.keys(smoke.on.workflow_call.inputs)).toEqual(['default-ref', 'ref']);
        expect(Object.keys(smoke.on.workflow_call.outputs)).toEqual(['outcome']);
    });

    test('only the signing job uses the android-signing environment, and only its signing step sees the secrets', () => {
        for (const [id, job] of Object.entries(jobs)) {
            expect([id, job.environment]).toEqual([id, id === 'android-sign' ? 'android-signing' : undefined]);
            expect([id, job.secrets]).toEqual([id, undefined]);
        }
        const signStep = jobs['android-sign'].steps.find(step => step.id === 'sign');
        expect(signStep.env).toEqual(Object.fromEntries(SIGNING_SECRETS.map(name => [name, `\${{ secrets.${name} }}`])));
        expect([...releaseSource.matchAll(/secrets\.(\w+)/g)].map(match => match[1]).sort()).toEqual([...SIGNING_SECRETS].sort());
        const otherSteps = Object.values(jobs).flatMap(job => job.steps ?? []).filter(step => step !== signStep);
        expect(otherSteps.filter(step => JSON.stringify(step).includes('secrets.'))).toEqual([]);
        expect(signStep.run).toContain('bash android/release/sign-release-apks.sh "$RUNNER_TEMP/android-unsigned" "$RUNNER_TEMP/android-release"');
        // The keystore never outlives the job, even when signing fails.
        expect(stepNamed(jobs['android-sign'], 'Delete the keystore')).toEqual({
            name: 'Delete the keystore',
            if: 'always()',
            run: 'rm -f android/.gradle/signing/release.keystore',
        });
    });

    test('nothing caches or uploads android/.gradle/', () => {
        const steps = Object.values(jobs).flatMap(job => job.steps ?? []);
        expect(steps.filter(step => String(step.uses).startsWith('actions/cache'))).toEqual([]);
        const uploads = steps.filter(step => String(step.uses).startsWith('actions/upload-artifact@'));
        expect(uploads.length).toBeGreaterThan(0);
        for (const upload of uploads) {
            expect(upload.with.path).not.toMatch(/\.gradle/);
        }
        for (const job of ['android-build', 'android-sign', 'android-reattach']) {
            expect(jobs[job].steps[0]).toMatchObject({ name: 'Checkout tag', with: { 'persist-credentials': false } });
        }
    });

    test('decide passes --skip-unpinned-runtime, never --allow-unpinned-runtime, and announces a skip', () => {
        const step = stepNamed(jobs.decide, 'Decide the Android APKs');
        expect(step.id).toBe('android');
        expect(step.env).toEqual({ GITHUB_TOKEN: '${{ github.token }}', TAG: '${{ github.ref_name }}', PRERELEASE: '${{ steps.tag.outputs.prerelease }}' });
        expect(step.run).toContain('node android/release/release-decision.mjs --prerelease "$PRERELEASE" --commit "$GITHUB_SHA"');
        expect(step.run).toContain('--exclude-tag "$TAG"');
        expect(step.run).toContain('--skip-unpinned-runtime');
        expect(releaseSource).not.toContain('--allow-unpinned-runtime');
        expect(step.run).toContain('echo \'::notice title=TODO(copy)::TODO(copy)\'');
        expect(step.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
    });

    test('the build runs the one recipe script with only the channel and an output directory', () => {
        const build = jobs['android-build'];
        const runs = build.steps.map(step => step.run).filter(Boolean);
        expect(runs).toContain('bash android/release/build-release-apks.sh "$DEFAULT_REF" "$RUNNER_TEMP/android-unsigned"');
        expect(stepNamed(build, 'Build the unsigned APKs and the sources archive').env).toEqual({ DEFAULT_REF: '${{ needs.decide.outputs.default-ref }}' });
        // Every option that changes the APK bytes lives in the recipe, which inputsHash covers.
        expect(releaseSource).not.toMatch(/gradlew|fetch-termux|fetch-node|build-npm|build-sources|notices\.py|includeX86_64|-PdefaultRef/);
        // Both are downloaded after the signing approval, which can wait up to 30 days.
        expect(stepNamed(build, 'Upload the unsigned APKs').with).toMatchObject({ 'name': 'android-unsigned-apks', 'path': '${{ runner.temp }}/android-unsigned/SillyBunny-android-*-unsigned.apk', 'retention-days': 30 });
        expect(stepNamed(build, 'Upload the sources archive').with).toMatchObject({ 'name': 'android-sources', 'path': '${{ runner.temp }}/android-unsigned/SillyBunny-android-sources.tar.zst', 'retention-days': 30 });
    });

    test('the signing job writes android-update.json from the signed APKs with the tools required', () => {
        const step = stepNamed(jobs['android-sign'], 'Write android-update.json');
        expect(step.run).toMatch(/^node android\/release\/update-manifest\.mjs --prerelease "\$PRERELEASE" --release-tag "\$TAG" /);
        for (const part of ['--inputs-hash "$INPUTS_HASH"', '--signing-cert-sha256 "$CERTIFICATE"', '--min-sdk "$MIN_SDK"', '--verify-tools require',
            '--apk "arm64-v8a=$RUNNER_TEMP/android-release/SillyBunny-android-arm64-v8a.apk"',
            '--apk "armeabi-v7a=$RUNNER_TEMP/android-release/SillyBunny-android-armeabi-v7a.apk"',
            '--out "$RUNNER_TEMP/android-release/android-update.json"']) {
            expect(step.run).toContain(part);
        }
        expect(stepIndex(jobs['android-sign'], 'Delete the keystore')).toBeLessThan(stepIndex(jobs['android-sign'], 'Write android-update.json'));
        expect(stepNamed(jobs['android-sign'], 'Upload the signed APKs and android-update.json').with).toMatchObject({ name: 'android-release', path: '${{ runner.temp }}/android-release' });
        expect(stepNamed(jobs['android-reattach'], 'Upload the APKs and android-update.json').with).toMatchObject({ name: 'android-release', path: '${{ runner.temp }}/android-release' });
    });

    test('the draft job adds the APKs, the manifest and the sources archive to SHA256SUMS and the attestation, and attaches the manifest last', () => {
        const draft = jobs['draft-release'];
        expect(draft.steps.map(step => step.name)).toEqual([
            'Check the Android jobs',
            'Checkout tag',
            'Setup Node.js',
            'Check the Android decision again',
            'Download the APKs and android-update.json',
            'Download the sources archive',
            'Check the APKs against android-update.json',
            'Collect release assets',
            'Attest release assets',
            'Create draft release',
            'Attach android-update.json',
        ]);
        expect(stepNamed(draft, 'Check the Android decision again').env).toEqual({
            GITHUB_TOKEN: '${{ github.token }}',
            TAG: '${{ github.ref_name }}',
            PRERELEASE: '${{ needs.decide.outputs.prerelease }}',
            ANDROID: '${{ needs.decide.outputs.android }}',
            INPUTS_HASH: '${{ needs.decide.outputs.inputs-hash }}',
            PREVIOUS_TAG: '${{ needs.decide.outputs.previous-tag }}',
        });
        expect(stepNamed(draft, 'Download the APKs and android-update.json')).toMatchObject({
            if: 'needs.decide.outputs.android != \'skip\'',
            with: { name: 'android-release', path: '${{ runner.temp }}/android-release' },
        });
        expect(stepNamed(draft, 'Download the sources archive')).toMatchObject({
            if: 'needs.decide.outputs.android == \'build\'',
            with: { name: 'android-sources', path: '${{ runner.temp }}/android-sources' },
        });
        const collect = stepNamed(draft, 'Collect release assets');
        expect(collect.run).toContain('for file in "$RUNNER_TEMP/android-release"/* "$RUNNER_TEMP/android-sources"/*; do');
        expect(collect.run.indexOf('android-release')).toBeLessThan(collect.run.indexOf('sha256sum -- * > SHA256SUMS'));
        expect(stepNamed(draft, 'Attest release assets').with).toEqual({ 'subject-path': '${{ steps.assets.outputs.dir }}/*' });
        expect(stepNamed(draft, 'Create draft release').env.PRERELEASE).toBe('${{ needs.decide.outputs.prerelease }}');
        expect(stepNamed(draft, 'Attach android-update.json')).toMatchObject({
            if: 'needs.decide.outputs.android != \'skip\'',
            env: { GITHUB_TOKEN: '${{ github.token }}', RELEASE_URL: '${{ steps.release.outputs.url }}', ASSET_DIR: '${{ steps.assets.outputs.dir }}' },
        });
        expect(stepNamed(draft, 'Attach android-update.json').run).toContain('node android/release/attach-update-manifest.mjs --repository "$GITHUB_REPOSITORY"');
        // Nothing ever publishes, deletes or replaces a release or its assets.
        expect(releaseSource).not.toMatch(/gh release (edit|delete|upload)|--clobber|draft=false|--draft=false/);
    });

    test('CODEOWNERS covers the Android app and its signing path', () => {
        const owners = readFileSync(path.join(repoRoot, '.github', 'CODEOWNERS'), 'utf8').split('\n');
        expect(owners).toContain('/android/** @TheLonelyDevil9 @Geechan');
        expect(owners).toContain('/.github/workflows/** @TheLonelyDevil9 @Geechan');
    });
});

describe('Android release scripts', () => {
    test('the build recipe runs track p45b\'s order from the pinned digests, unsigned and without x86_64', () => {
        const recipe = readRepoFile('android/release/build-release-apks.sh');
        const order = [
            'run_step fetch-termux bash "$runtime/fetch-termux.sh"',
            'run_step fetch-node python3 -I -B "$runtime/fetch-node.py" --abi arm64-v8a --abi armeabi-v7a',
            'run_step build-npm python3 -I -B "$runtime/build-npm.py"',
            'run_step build-sources bash "$runtime/build-sources.sh" --require-node --output "$out/SillyBunny-android-sources.tar.zst"',
            'run_step check-staged-runtime node "$root/android/release/check-staged-runtime.mjs"',
            './gradlew --no-daemon --console=plain "-PdefaultRef=$2" :app:assembleRelease',
        ].map(line => recipe.indexOf(line));
        expect(order.every(index => index > 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        const commands = recipe.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
        expect(commands).not.toMatch(/--local|includeX86_64|-PrequireRuntime|sillybunny\.nodeDir/);
    });

    test('the signing script zipaligns before signing, signs v2 and v3 only, and passes passwords by reference', () => {
        const script = readRepoFile('android/release/sign-release-apks.sh');
        const align = script.indexOf('"$tools/zipalign" -P 16 -f 4 "$unsigned" "$aligned"');
        const sign = script.indexOf('"$tools/apksigner" sign');
        expect(align).toBeGreaterThan(0);
        expect(sign).toBeGreaterThan(align);
        expect(script).toContain('--v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false');
        expect(script).toContain('--ks-pass env:ANDROID_KEYSTORE_PASSWORD');
        expect(script).toContain('--key-pass env:ANDROID_KEY_PASSWORD');
        expect(script).toContain('keystore="$root/android/.gradle/signing/release.keystore"');
        expect(script).toContain('trap cleanup EXIT');
        expect(script).toContain('verify --min-sdk-version "$min_sdk" --max-sdk-version "$target_sdk" --verbose --print-certs');
    });
});

// A runtime.lock whose node and npm pins fix their payloads.
const pinnedBinary = abi => ({
    repository: 'ghcr.io/sillybunnyteam/sillybunny-android-runtime',
    tag: `node-24.22.0-1494da0071c0-${abi}`,
    digest: `sha256:${(abi === 'arm64-v8a' ? '1' : '2').repeat(64)}`,
    sha256: (abi === 'arm64-v8a' ? '3' : '4').repeat(64),
    size: abi === 'arm64-v8a' ? 4096 : 2048,
});
const PINNED_LOCK = {
    schema: 1,
    node: {
        version: '24.22.0',
        source: { tarball: 'node-v24.22.0.tar.xz', tarballSha256: 'f'.repeat(64) },
        patchSet: { sha256: '1494da0071c0'.padEnd(64, '0') },
        binaries: { 'arm64-v8a': pinnedBinary('arm64-v8a'), 'armeabi-v7a': pinnedBinary('armeabi-v7a') },
    },
    npm: { version: '11.19.1', source: 'node' },
};
const UNPINNED_LOCK = {
    ...PINNED_LOCK,
    node: { ...PINNED_LOCK.node, binaries: { ...PINNED_LOCK.node.binaries, 'armeabi-v7a': { ...pinnedBinary('armeabi-v7a'), digest: null, sha256: null, size: null } } },
};

function manifestFixture({ versionCode = 1, prerelease = false, inputsHash = HASH_A, releaseTag, assets } = {}) {
    return {
        schema: 1,
        versionCode,
        versionName: `1.${versionCode}.0`,
        prerelease,
        releaseTag: releaseTag ?? (prerelease ? `v2.${versionCode}.0-rc.1` : `v2.${versionCode}.0`),
        defaultRef: prerelease ? 'staging' : 'release',
        minSdk: 29,
        signingCertSha256: SIGNER,
        inputsHash,
        assets: assets ?? {
            'arm64-v8a': { name: 'SillyBunny-android-arm64-v8a.apk', sha256: 'cd'.repeat(32), size: 131073 },
            'armeabi-v7a': { name: 'SillyBunny-android-armeabi-v7a.apk', sha256: 'ef'.repeat(32), size: 131000 },
        },
        runtime: { node: '24.22.0', bun: null, git: '2.56.0', bash: '5.3.20', npm: '11.19.1' },
    };
}

const releaseOf = (manifest, extra = {}) => ({ tag: manifest.releaseTag, draft: false, prerelease: manifest.prerelease, publishedAt: '2026-10-01T00:00:00Z', manifest, ...extra });
const decide = ({ previous = [], ...rest } = {}) => decideRelease({
    prerelease: false, inputsHash: HASH_B, versionCode: 2, versionName: '1.2.0', minAppVersion: 1n, runtimeLock: PINNED_LOCK, previous, ...rest,
});

/** The JSON details after the placeholder in a TODO(copy) error message. */
function detailsOf(error) {
    const match = /^TODO\(copy\) (\{.*\})$/.exec(error.message);
    expect(match).not.toBeNull();
    return JSON.parse(match[1]);
}

function thrown(run) {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected an error');
}

describe('the decision with an unpinned runtime.lock (--skip-unpinned-runtime)', () => {
    test('skips the APKs when no earlier release carries android-update.json', () => {
        const decision = decide({ runtimeLock: UNPINNED_LOCK, skipUnpinnedRuntime: true });
        expect(decision).toMatchObject({ action: 'skip', previous: null, prerelease: false, defaultRef: 'release', unpinnedRuntime: ['node'] });
        expect(decision.reasons).toEqual(['TODO(copy) {"code":"unpinned-runtime-skip","unpinned":["node"]}']);
        expect(decide({ prerelease: true, runtimeLock: UNPINNED_LOCK, skipUnpinnedRuntime: true })).toMatchObject({ action: 'skip', defaultRef: 'staging' });
    });

    test('fails before anything is drafted once a release, even a draft, carries android-update.json', () => {
        for (const previous of [
            [releaseOf(manifestFixture({ versionCode: 1 }))],
            [releaseOf(manifestFixture({ versionCode: 1, prerelease: true }), { draft: true, publishedAt: null })],
        ]) {
            const error = thrown(() => decide({ runtimeLock: UNPINNED_LOCK, skipUnpinnedRuntime: true, previous }));
            expect(error).toBeInstanceOf(ReleaseToolError);
            expect(detailsOf(error)).toEqual({
                code: 'unpinned-runtime-after-android-release',
                unpinned: ['node'],
                release: previous[0].tag,
                draft: previous[0].draft,
            });
        }
    });

    test('has no effect once the runtime is pinned, and cannot be combined with --allow-unpinned-runtime', () => {
        expect(decide({ skipUnpinnedRuntime: true })).toMatchObject({ action: 'build', versionCode: 2 });
        const previous = [releaseOf(manifestFixture({ versionCode: 2, inputsHash: HASH_B }))];
        expect(decide({ skipUnpinnedRuntime: true, previous })).toMatchObject({ action: 'reattach', previous: { tag: 'v2.2.0' } });
        const error = thrown(() => decide({ runtimeLock: UNPINNED_LOCK, skipUnpinnedRuntime: true, allowUnpinnedRuntime: true }));
        expect(error).toBeInstanceOf(UsageError);
        expect(detailsOf(error).code).toBe('conflicting-options');
    });
});

function stagedFixture() {
    const tarball = { filename: 'node-v24.22.0.tar.xz', sha256: 'f'.repeat(64), url: 'https://nodejs.org/dist/v24.22.0/node-v24.22.0.tar.xz' };
    const nodeJson = {
        schema: 1,
        version: '24.22.0',
        abis: Object.fromEntries(['arm64-v8a', 'armeabi-v7a'].map(abi => [abi, { sha256: pinnedBinary(abi).sha256, size: pinnedBinary(abi).size }])),
        source: {
            kind: 'ghcr',
            repository: 'ghcr.io/sillybunnyteam/sillybunny-android-runtime',
            patchSetSha256: PINNED_LOCK.node.patchSet.sha256,
            artifacts: Object.fromEntries(['arm64-v8a', 'armeabi-v7a'].map(abi => [abi, { tag: pinnedBinary(abi).tag, digest: pinnedBinary(abi).digest }])),
            tarball,
        },
    };
    const npmJson = { schema: 1, version: '11.19.1', sha256: '5'.repeat(64), size: 1000, files: 10, contentBytes: 2000, source: { kind: 'node-source-tarball', node: '24.22.0', tarball } };
    return { nodeJson, npmJson };
}

describe('the staged runtime check (check-staged-runtime.mjs)', () => {
    test('accepts Node fetched from the pinned digests and npm from the pinned Node source', () => {
        expect(stagedRuntimeProblems({ runtimeLock: PINNED_LOCK, ...stagedFixture() })).toEqual([]);
    });

    test('refuses an unpinned lock, --local Node, extra ABIs and payloads that differ from the pins', () => {
        const problems = mutate => {
            const fixture = stagedFixture();
            mutate(fixture);
            return stagedRuntimeProblems({ runtimeLock: PINNED_LOCK, ...fixture }).map(problem => `${problem.code} ${problem.file} ${problem.field}`);
        };
        expect(stagedRuntimeProblems({ runtimeLock: UNPINNED_LOCK, ...stagedFixture() })).toEqual([{ code: 'runtime-unpinned', unpinned: ['node'] }]);
        expect(problems(({ nodeJson }) => {
            nodeJson.source = { kind: 'local', tarball: nodeJson.source.tarball };
        })).toEqual([
            'mismatch node.json source.kind',
            'mismatch node.json source.repository',
            'mismatch node.json source.patchSetSha256',
            'mismatch node.json source.artifacts',
            'mismatch node.json source.artifacts.arm64-v8a',
            'mismatch node.json source.artifacts.armeabi-v7a',
        ]);
        expect(problems(({ nodeJson }) => {
            nodeJson.abis.x86_64 = { sha256: '6'.repeat(64), size: 1 };
        })).toEqual(['mismatch node.json abis']);
        expect(problems(({ nodeJson }) => {
            nodeJson.abis['arm64-v8a'].size += 1;
            nodeJson.source.artifacts['armeabi-v7a'].digest = `sha256:${'7'.repeat(64)}`;
        })).toEqual(['mismatch node.json abis.arm64-v8a', 'mismatch node.json source.artifacts.armeabi-v7a']);
        expect(problems(({ nodeJson, npmJson }) => {
            delete nodeJson.source.tarball;
            npmJson.version = '11.0.0';
            npmJson.source.node = '22.0.0';
            delete npmJson.sha256;
        })).toEqual([
            'mismatch node.json source.tarball',
            'mismatch npm.json version',
            'mismatch npm.json source.node',
            'invalid npm.json sha256',
        ]);
        expect(stagedRuntimeProblems({ runtimeLock: PINNED_LOCK, nodeJson: null, npmJson: [] })).toEqual([
            { code: 'not-an-object', file: 'node.json' },
            { code: 'not-an-object', file: 'npm.json' },
        ]);
    });

    test('the command line also compares the staged files with their records', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'release-staged-runtime-'));
        try {
            const lock = JSON.parse(JSON.stringify(PINNED_LOCK));
            const { nodeJson, npmJson } = stagedFixture();
            const write = (file, bytes) => {
                mkdirSync(path.dirname(file), { recursive: true });
                writeFileSync(file, bytes);
            };
            for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
                const bytes = randomBytes(lock.node.binaries[abi].size);
                write(path.join(dir, 'node-out', abi, 'libnode.so'), bytes);
                lock.node.binaries[abi].sha256 = createHash('sha256').update(bytes).digest('hex');
                nodeJson.abis[abi].sha256 = lock.node.binaries[abi].sha256;
            }
            const npmZip = randomBytes(1000);
            npmJson.sha256 = createHash('sha256').update(npmZip).digest('hex');
            write(path.join(dir, 'npm-out', 'npm.zip'), npmZip);
            write(path.join(dir, 'runtime.lock'), JSON.stringify(lock));
            write(path.join(dir, 'node-out', 'node.json'), JSON.stringify(nodeJson));
            write(path.join(dir, 'npm-out', 'npm.json'), JSON.stringify(npmJson));
            const run = () => spawnSync(process.execPath, [path.join(repoRoot, 'android', 'release', 'check-staged-runtime.mjs'),
                '--runtime-lock', path.join(dir, 'runtime.lock'), '--node-out', path.join(dir, 'node-out'), '--npm-out', path.join(dir, 'npm-out')], { encoding: 'utf8' });
            const passed = run();
            expect([passed.status, passed.stderr]).toEqual([0, '']);
            expect(JSON.parse(passed.stdout)).toEqual({ node: '24.22.0', npm: '11.19.1', abis: ['arm64-v8a', 'armeabi-v7a'], source: 'ghcr', tarball: 'node-v24.22.0.tar.xz' });
            write(path.join(dir, 'npm-out', 'npm.zip'), Buffer.concat([npmZip.subarray(1), Buffer.from('x')]));
            const failed = run();
            expect(failed.status).toBe(1);
            const details = JSON.parse(/^check-staged-runtime: TODO\(copy\) (\{.*\})\n$/.exec(failed.stderr)[1]);
            expect(details).toMatchObject({ code: 'staged-runtime-mismatch', problems: [{ code: 'mismatch', file: 'npm.zip', field: 'bytes' }] });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

function fakeResponse(status, { body = '', headers = {} } = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        json: async () => JSON.parse(bytes.toString('utf8')),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
}

const API = 'https://api.github.com';
const DRAFT_URL = 'https://github.com/team/app/releases/tag/untagged-0123456789abcdef';
const LIST = `${API}/repos/team/app/releases?per_page=100&page=1`;
const UPLOAD = 'https://uploads.github.com/repos/team/app/releases/7/assets';
const STORAGE = 'https://release-assets.githubusercontent.test';

/** A draft release on a fake GitHub that serves its APK assets from a storage host and accepts uploads. */
function fakeRelease({ release: changes = {}, apks: apkChanges = {}, extraAssets = [], readBack } = {}) {
    const apks = {
        'arm64-v8a': randomBytes(4099),
        'armeabi-v7a': randomBytes(2051),
    };
    const assets = Object.fromEntries(Object.entries(apks).map(([abi, bytes]) => [abi, {
        name: `SillyBunny-android-${abi}.apk`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
    }]));
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestFixture({ versionCode: 3, prerelease: true, assets }), null, 2)}\n`);
    const served = { ...apks, ...apkChanges };
    const releaseAssets = Object.keys(apks).map((abi, index) => ({
        id: index + 1,
        name: assets[abi].name,
        size: assets[abi].size,
        state: 'uploaded',
        url: `${API}/repos/team/app/releases/assets/${index + 1}`,
    }));
    const release = {
        id: 7,
        html_url: DRAFT_URL,
        tag_name: 'v2.3.0-rc.1',
        draft: true,
        prerelease: true,
        upload_url: `${UPLOAD}{?name,label}`,
        assets: [...releaseAssets, ...extraAssets],
        ...changes,
    };
    const calls = [];
    let uploaded = null;
    const fetch = async (url, init) => {
        calls.push({ url, method: init.method, authorization: init.headers.Authorization ?? null, redirect: init.redirect });
        if (url === LIST) {
            return fakeResponse(200, { body: [{ id: 6, html_url: 'https://github.com/team/app/releases/tag/v2.2.0', draft: false, assets: [] }, release] });
        }
        const asset = /\/releases\/assets\/(\d+)$/.exec(url);
        if (asset && init.method === 'GET') {
            return fakeResponse(302, { headers: { location: `${STORAGE}/asset-${asset[1]}?token=signed` } });
        }
        const stored = /^https:\/\/release-assets\.githubusercontent\.test\/asset-(\d+)\?token=signed$/.exec(url);
        if (stored) {
            const id = Number(stored[1]);
            if (id === 99) {
                return fakeResponse(200, { body: readBack ?? uploaded });
            }
            return fakeResponse(200, { body: served[Object.keys(apks)[id - 1]] });
        }
        if (url === `${UPLOAD}?name=android-update.json` && init.method === 'POST') {
            uploaded = Buffer.from(init.body);
            return fakeResponse(201, { body: { id: 99, name: 'android-update.json', size: uploaded.length, state: 'uploaded', url: `${API}/repos/team/app/releases/assets/99` } });
        }
        return fakeResponse(404);
    };
    return { fetch, calls, manifestBytes, apks };
}

const attach = (fake, options = {}) => attachUpdateManifest({
    repository: 'team/app', releaseUrl: DRAFT_URL, manifestBytes: fake.manifestBytes, token: 'test-token', fetch: fake.fetch, attempts: 2, sleep: async () => {}, ...options,
});

async function attachError(fake, options) {
    try {
        await attach(fake, options);
    } catch (error) {
        return error;
    }
    throw new Error('expected attachUpdateManifest to fail');
}

describe('attaching android-update.json to the draft (attach-update-manifest.mjs)', () => {
    test('checks every listed APK on the draft, then uploads the manifest and reads it back', async () => {
        const fake = fakeRelease();
        const summary = await attach(fake);
        expect(summary).toMatchObject({ release: DRAFT_URL, draft: true, prerelease: true, releaseTag: 'v2.3.0-rc.1', versionCode: 3 });
        expect(summary.assets['arm64-v8a']).toEqual({ name: 'SillyBunny-android-arm64-v8a.apk', size: 4099, sha256: createHash('sha256').update(fake.apks['arm64-v8a']).digest('hex') });
        expect(summary.manifest).toEqual({ name: 'android-update.json', size: fake.manifestBytes.length, sha256: createHash('sha256').update(fake.manifestBytes).digest('hex') });
        const order = fake.calls.map(call => `${call.method} ${call.url.split('?')[0]}`);
        const post = order.indexOf(`POST ${UPLOAD}`);
        expect(post).toBeGreaterThan(order.lastIndexOf(`GET ${STORAGE}/asset-2`));
        expect(order.lastIndexOf(`GET ${STORAGE}/asset-1`)).toBeLessThan(post);
        expect(order.slice(post + 1)).toEqual([`GET ${API}/repos/team/app/releases/assets/99`, `GET ${STORAGE}/asset-99`]);
        // The token reaches only the API and upload hosts, never the asset storage host.
        for (const call of fake.calls) {
            expect([call.url.split('?')[0], call.authorization]).toEqual([call.url.split('?')[0], call.url.startsWith(STORAGE) ? null : 'Bearer test-token']);
            expect(call.redirect).toBe('manual');
        }
    });

    test('uploads nothing unless every APK the manifest lists is on the draft with its size and SHA-256', async () => {
        const cases = [
            [{ release: { assets: [] } }, 'apk-asset-count'],
            [{ apks: { 'armeabi-v7a': randomBytes(2051) } }, 'apk-asset-mismatch'],
            [{ apks: { 'arm64-v8a': randomBytes(4098) } }, 'apk-asset-mismatch'],
            [{ release: { draft: false } }, 'release-not-draft'],
            [{ release: { prerelease: false } }, 'prerelease-mismatch'],
            [{ release: { html_url: 'https://github.com/team/app/releases/tag/untagged-other' } }, 'release-not-found'],
            [{ release: { upload_url: 'https://uploads.example.test/repos/team/app/releases/7/assets{?name,label}' } }, 'upload-host-untrusted'],
        ];
        for (const [changes, code] of cases) {
            const fake = fakeRelease(changes);
            const error = await attachError(fake);
            expect([code, error.details?.code]).toEqual([code, code]);
            expect(fake.calls.filter(call => call.method === 'POST')).toEqual([]);
        }
        const listed = { name: 'android-update.json', size: 1, state: 'uploaded', url: `${API}/repos/team/app/releases/assets/50` };
        const fake = fakeRelease({ extraAssets: [listed] });
        expect((await attachError(fake)).details.code).toBe('manifest-already-attached');
        expect(fake.calls.filter(call => call.method === 'POST')).toEqual([]);
        const sizes = fakeRelease();
        sizes.manifestBytes = Buffer.from(sizes.manifestBytes.toString('utf8').replace('"size": 4099', '"size": 4100'));
        expect((await attachError(sizes)).details.code).toBe('apk-asset-size');
        expect(sizes.calls.filter(call => call.method === 'POST')).toEqual([]);
    });

    test('fails when the uploaded manifest does not read back byte for byte, and rejects invalid manifests', async () => {
        const fake = fakeRelease({ readBack: Buffer.from('{}') });
        expect((await attachError(fake)).details.code).toBe('manifest-read-back-mismatch');
        const invalid = fakeRelease();
        invalid.manifestBytes = Buffer.from('{"schema": 1}');
        expect((await attachError(invalid)).details.code).toBe('manifest-invalid');
        expect(invalid.calls).toEqual([]);
        const error = await attachError(fakeRelease(), { repository: 'not a repository' });
        expect(error).toBeInstanceOf(UsageError);
    });
});

/** Files a fake command can use: `bin` goes first on PATH. */
function makeBin(dir, commands) {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    for (const [name, script] of Object.entries(commands)) {
        writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${script}`);
        chmodSync(path.join(bin, name), 0o755);
    }
    return bin;
}

/** Runs a `run:` block like the runner's default shell (`bash -e`), with GITHUB_OUTPUT and GITHUB_STEP_SUMMARY. */
function runStep(script, { env = {}, cwd, bin } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-step-'));
    try {
        const file = path.join(dir, 'step.sh');
        const output = path.join(dir, 'output');
        const summary = path.join(dir, 'summary');
        writeFileSync(file, script);
        writeFileSync(output, '');
        writeFileSync(summary, '');
        const result = spawnSync('bash', ['-e', file], {
            cwd: cwd ?? dir,
            env: {
                PATH: bin ? `${bin}${path.delimiter}${process.env.PATH}` : process.env.PATH,
                HOME: process.env.HOME,
                RUNNER_TEMP: dir,
                ...env,
                GITHUB_OUTPUT: output,
                GITHUB_STEP_SUMMARY: summary,
            },
            encoding: 'utf8',
        });
        const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        return { code: result.status, stdout: result.stdout, stderr: result.stderr, outputs, summary: readFileSync(summary, 'utf8') };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');

/** RUNNER_TEMP contents for the draft job: android-release (APKs, manifest) and, for a build, android-sources. */
function writeAndroidFiles(temp, { releaseTag = 'v2.3.0', sources = true } = {}) {
    const dir = path.join(temp, 'android-release');
    mkdirSync(dir, { recursive: true });
    const assets = {};
    for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
        const bytes = randomBytes(1024);
        writeFileSync(path.join(dir, `SillyBunny-android-${abi}.apk`), bytes);
        assets[abi] = { name: `SillyBunny-android-${abi}.apk`, sha256: sha256Of(bytes), size: bytes.length };
    }
    writeFileSync(path.join(dir, 'android-update.json'), `${JSON.stringify(manifestFixture({ versionCode: 3, releaseTag, assets, inputsHash: HASH_B }), null, 2)}\n`);
    if (sources) {
        mkdirSync(path.join(temp, 'android-sources'));
        writeFileSync(path.join(temp, 'android-sources', 'SillyBunny-android-sources.tar.zst'), randomBytes(512));
    }
    return dir;
}

describePosix('release.yml step scripts (POSIX)', () => {
    let temp;
    beforeAll(() => {
        temp = mkdtempSync(path.join(tmpdir(), 'release-workflow-'));
    });
    afterAll(() => {
        rmSync(temp, { recursive: true, force: true });
    });

    test('decide outputs the decision, and a skip leaves a notice and a job-summary line', () => {
        const step = stepNamed(jobs.decide, 'Decide the Android APKs');
        const dir = mkdtempSync(path.join(temp, 'decide-'));
        const bin = makeBin(dir, {
            node: 'printf \'%s\\n\' "$*" > "$NODE_ARGS"\ncat "$DECISION"\nexit "${DECISION_STATUS:-0}"\n',
        });
        const run = (decision, status = 0) => {
            writeFileSync(path.join(dir, 'decision.json'), JSON.stringify(decision));
            return runStep(step.run, { bin, env: {
                DECISION: path.join(dir, 'decision.json'), DECISION_STATUS: String(status), NODE_ARGS: path.join(dir, 'args'),
                PRERELEASE: 'false', TAG: 'v2.3.0', GITHUB_SHA: 'c'.repeat(40), GITHUB_REPOSITORY: 'team/app', GITHUB_API_URL: API,
            } });
        };
        const base = { defaultRef: 'release', inputsHash: HASH_B, previous: null };
        const skip = run({ ...base, action: 'skip' });
        expect(skip.code).toBe(0);
        expect(skip.outputs).toEqual({ 'action': 'skip', 'default-ref': 'release', 'inputs-hash': HASH_B, 'previous-tag': '' });
        expect(skip.stdout).toContain('::notice title=TODO(copy)::TODO(copy)\n');
        expect(skip.summary).toBe('TODO(copy)\n\n- android: `skip`\n- reason: `unpinned-runtime`\n');
        expect(readFileSync(path.join(dir, 'args'), 'utf8')).toBe(`android/release/release-decision.mjs --prerelease false --commit ${'c'.repeat(40)} --github-repository team/app --github-api-url ${API} --exclude-tag v2.3.0 --skip-unpinned-runtime\n`);
        const reattach = run({ ...base, action: 'reattach', previous: { tag: 'v2.2.0' } });
        expect([reattach.code, reattach.outputs.action, reattach.outputs['previous-tag'], reattach.summary]).toEqual([0, 'reattach', 'v2.2.0', '']);
        expect(reattach.stdout).not.toContain('::notice');
        const failed = run({}, 1);
        expect([failed.code, failed.outputs]).toEqual([1, {}]);
        expect(failed.stdout).toContain(ERROR_ANNOTATION);
        expect(run({ ...base, action: 'publish' }).code).toBe(1);
    });

    test('the draft job makes the decision again with decide\'s flags and stops if it changed', () => {
        const step = stepNamed(jobs['draft-release'], 'Check the Android decision again');
        const dir = mkdtempSync(path.join(temp, 'decide-again-'));
        const bin = makeBin(dir, {
            node: 'printf \'%s\\n\' "$*" > "$NODE_ARGS"\ncat "$DECISION"\nexit "${DECISION_STATUS:-0}"\n',
        });
        const run = (decision, env = {}, status = 0) => {
            writeFileSync(path.join(dir, 'decision.json'), JSON.stringify(decision));
            return runStep(step.run, { bin, env: {
                DECISION: path.join(dir, 'decision.json'), DECISION_STATUS: String(status), NODE_ARGS: path.join(dir, 'args'),
                PRERELEASE: 'false', TAG: 'v2.3.0', GITHUB_SHA: 'c'.repeat(40), GITHUB_REPOSITORY: 'team/app', GITHUB_API_URL: API,
                ANDROID: 'build', INPUTS_HASH: HASH_B, PREVIOUS_TAG: '', ...env,
            } });
        };
        const build = { action: 'build', defaultRef: 'release', inputsHash: HASH_B, previous: null };
        expect(run(build).code).toBe(0);
        expect(readFileSync(path.join(dir, 'args'), 'utf8')).toBe(`android/release/release-decision.mjs --prerelease false --commit ${'c'.repeat(40)} --github-repository team/app --github-api-url ${API} --exclude-tag v2.3.0 --skip-unpinned-runtime\n`);
        expect(run({ ...build, action: 'reattach', previous: { tag: 'v2.2.0' } }, { ANDROID: 'reattach', PREVIOUS_TAG: 'v2.2.0' }).code).toBe(0);
        expect(run({ ...build, action: 'skip' }, { ANDROID: 'skip' }).code).toBe(0);
        for (const [decision, status] of [
            [{ ...build, action: 'reattach', previous: { tag: 'v2.3.0-rc.1' } }, 0],
            [{ ...build, inputsHash: HASH_A }, 0],
            [{ ...build, previous: { tag: 'v2.2.0' } }, 0],
            [{}, 1],
        ]) {
            const result = run(decision, {}, status);
            expect([decision, result.code]).toEqual([decision, 1]);
            expect(result.stdout).toContain(ERROR_ANNOTATION);
            expect(JSON.parse(result.stderr.trim().split('\n').at(-1)).code).toBe('android-decision-changed');
        }
    });

    test('the draft job runs only after Android jobs that match the decision', () => {
        const step = stepNamed(jobs['draft-release'], 'Check the Android jobs');
        const check = (ANDROID, BUILD, SMOKE, SMOKE_OUTCOME, SIGN, REATTACH) => runStep(step.run, { env: { ANDROID, BUILD, SMOKE, SMOKE_OUTCOME, SIGN, REATTACH } });
        expect(check('skip', 'skipped', 'skipped', '', 'skipped', 'skipped').code).toBe(0);
        expect(check('build', 'success', 'success', 'passed', 'success', 'skipped').code).toBe(0);
        expect(check('reattach', 'skipped', 'success', 'passed', 'skipped', 'success').code).toBe(0);
        for (const failing of [
            ['build', 'success', 'success', 'skipped', 'skipped', 'skipped'],
            ['build', 'failure', 'success', 'passed', 'skipped', 'skipped'],
            ['build', 'success', 'failure', '', 'skipped', 'skipped'],
            ['build', 'success', 'success', 'passed', 'failure', 'skipped'],
            ['reattach', 'skipped', 'success', 'passed', 'skipped', 'failure'],
            ['reattach', 'skipped', 'success', 'skipped', 'skipped', 'skipped'],
            ['skip', 'skipped', 'skipped', '', 'skipped', 'success'],
        ]) {
            const result = check(...failing);
            expect([failing, result.code]).toEqual([failing, 1]);
            expect(result.stdout).toContain(ERROR_ANNOTATION);
            expect(JSON.parse(result.stderr).code).toBe('android-jobs-incomplete');
        }
    });

    test('the draft job checks the APKs against android-update.json before collecting them', () => {
        const step = stepNamed(jobs['draft-release'], 'Check the APKs against android-update.json');
        const env = runner => ({ RUNNER_TEMP: runner, TAG: 'v2.3.0', PRERELEASE: 'false', INPUTS_HASH: HASH_B, ANDROID: 'build' });
        const fresh = name => {
            const runner = path.join(temp, name);
            mkdirSync(runner);
            return runner;
        };
        const ok = fresh('check-ok');
        writeAndroidFiles(ok);
        expect(runStep(step.run, { cwd: repoRoot, env: env(ok) }).code).toBe(0);

        const changed = fresh('check-changed');
        const dir = writeAndroidFiles(changed);
        writeFileSync(path.join(dir, 'SillyBunny-android-arm64-v8a.apk'), randomBytes(1024));
        const mismatch = runStep(step.run, { cwd: repoRoot, env: env(changed) });
        expect(mismatch.code).toBe(1);
        expect(mismatch.stderr).toMatch(/arm64-v8a APK .* has 1024 bytes and SHA-256 [0-9a-f]{64}; android-update\.json lists 1024 bytes/);

        const extra = fresh('check-extra');
        writeFileSync(path.join(writeAndroidFiles(extra), 'stray.apk'), 'x');
        expect(JSON.parse(runStep(step.run, { cwd: repoRoot, env: env(extra) }).stderr.trim().split('\n').at(-1)).code).toBe('android-release-files');

        // A re-attached manifest keeps the release tag of the release that first carried its APKs.
        const reattached = fresh('check-reattach');
        writeAndroidFiles(reattached, { releaseTag: 'v2.2.0', sources: false });
        expect(JSON.parse(runStep(step.run, { cwd: repoRoot, env: env(reattached) }).stderr.trim().split('\n').at(-1)).code).toBe('android-release-tag');
        expect(runStep(step.run, { cwd: repoRoot, env: { ...env(reattached), ANDROID: 'reattach' } }).code).toBe(0);
        expect(runStep(step.run, { cwd: repoRoot, env: { ...env(ok), INPUTS_HASH: HASH_A } }).code).toBe(1);
    });

    test('SHA256SUMS covers the bootstrap installers, the APKs, android-update.json and the sources archive', () => {
        const step = stepNamed(jobs['draft-release'], 'Collect release assets');
        const checkout = path.join(temp, 'collect-checkout');
        mkdirSync(path.join(checkout, 'scripts', 'bootstrap'), { recursive: true });
        writeFileSync(path.join(checkout, 'scripts', 'bootstrap', 'install.sh'), '#!/bin/sh\n');
        writeFileSync(path.join(checkout, 'scripts', 'bootstrap', 'install.ps1'), 'Write-Host\n');
        const collect = runner => runStep(step.run, { cwd: checkout, env: { RUNNER_TEMP: runner } });
        const sums = dir => readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map(line => line.split('  ')[1]);

        const build = path.join(temp, 'collect-build');
        mkdirSync(build);
        writeAndroidFiles(build);
        const built = collect(build);
        expect([built.code, built.outputs]).toEqual([0, { 'has-assets': 'true', 'dir': path.join(build, 'release-assets') }]);
        expect(sums(built.outputs.dir)).toEqual([
            'SillyBunny-android-arm64-v8a.apk',
            'SillyBunny-android-armeabi-v7a.apk',
            'SillyBunny-android-sources.tar.zst',
            'android-update.json',
            'install.ps1',
            'install.sh',
        ]);
        const apk = readFileSync(path.join(build, 'android-release', 'SillyBunny-android-arm64-v8a.apk'));
        expect(readFileSync(path.join(built.outputs.dir, 'SHA256SUMS'), 'utf8')).toContain(`${sha256Of(apk)}  SillyBunny-android-arm64-v8a.apk\n`);

        // Without Android files (a skip) the assets are exactly what they were before the APKs.
        const skip = path.join(temp, 'collect-skip');
        mkdirSync(skip);
        const skipped = collect(skip);
        expect(skipped.code).toBe(0);
        expect(sums(skipped.outputs.dir)).toEqual(['install.ps1', 'install.sh']);
        expect(readdirSync(skipped.outputs.dir).sort()).toEqual(['SHA256SUMS', 'install.ps1', 'install.sh']);

        const collision = path.join(temp, 'collect-collision');
        writeFileSync(path.join(writeAndroidFiles(collision), 'install.sh'), 'x');
        const collided = collect(collision);
        expect(collided.code).toBe(1);
        expect(JSON.parse(collided.stderr)).toEqual({ code: 'asset-name-collision', name: 'install.sh' });
    });

    test('the draft is created with every asset except android-update.json, and its URL is kept for the manifest', () => {
        const step = stepNamed(jobs['draft-release'], 'Create draft release');
        const dir = mkdtempSync(path.join(temp, 'create-'));
        const assets = path.join(dir, 'assets');
        mkdirSync(assets);
        for (const name of ['SHA256SUMS', 'SillyBunny-android-arm64-v8a.apk', 'SillyBunny-android-armeabi-v7a.apk', 'SillyBunny-android-sources.tar.zst', 'android-update.json', 'install.sh']) {
            writeFileSync(path.join(assets, name), name);
        }
        const bin = makeBin(dir, { gh: 'printf \'%s\\n\' "$@" > "$GH_ARGS"\nprintf \'%s\\n\' "$GH_PRINTS"\n' });
        const create = (env = {}) => {
            const result = runStep(step.run, { bin, env: { GH_ARGS: path.join(dir, 'args'), GH_PRINTS: DRAFT_URL, TAG: 'v2.3.0', PRERELEASE: 'false', ASSET_DIR: assets, ...env } });
            return { ...result, args: readFileSync(path.join(dir, 'args'), 'utf8').trim().split('\n') };
        };
        const stable = create();
        expect(stable.code).toBe(0);
        expect(stable.outputs).toEqual({ url: DRAFT_URL });
        expect(stable.args).toEqual([
            'release', 'create', 'v2.3.0', '--draft', '--verify-tag', '--generate-notes', '--title', 'v2.3.0', '--latest',
            ...['SHA256SUMS', 'SillyBunny-android-arm64-v8a.apk', 'SillyBunny-android-armeabi-v7a.apk', 'SillyBunny-android-sources.tar.zst', 'install.sh'].map(name => path.join(assets, name)),
        ]);
        expect(create({ PRERELEASE: 'true' }).args[8]).toBe('--prerelease');
        // Without a usable URL the manifest step fails; drafting itself stays as before.
        const odd = create({ GH_PRINTS: 'created' });
        expect([odd.code, odd.outputs]).toEqual([0, {}]);
        const attachStep = stepNamed(jobs['draft-release'], 'Attach android-update.json');
        const noUrl = runStep(attachStep.run, { env: { RELEASE_URL: '', ASSET_DIR: assets, GITHUB_REPOSITORY: 'team/app', GITHUB_API_URL: API } });
        expect(noUrl.code).toBe(1);
        expect(JSON.parse(noUrl.stderr)).toEqual({ code: 'release-url-unexpected' });
    });

    test('a re-attach downloads the previous release\'s manifest and APKs and checks them byte for byte', () => {
        const step = jobs['android-reattach'].steps.find(candidate => candidate.name === 'Download and check the previous release\'s APKs');
        const dir = mkdtempSync(path.join(temp, 'reattach-'));
        const previous = writeAndroidFiles(path.join(dir, 'previous'), { releaseTag: 'v2.2.0', sources: false });
        const bin = makeBin(dir, {
            gh: '[ "$1 $2 $3 $4 $5" = "release download v2.2.0 --repo team/app" ] || exit 3\n[ "$6" = --pattern ] && [ "$8" = --dir ] || exit 4\ncp "$PREVIOUS/$7" "$9/"\n',
        });
        const run = runner => runStep(step.run, { cwd: repoRoot, bin, env: {
            RUNNER_TEMP: runner, PREVIOUS: previous, PREVIOUS_TAG: 'v2.2.0', PRERELEASE: 'false', INPUTS_HASH: HASH_B, GITHUB_REPOSITORY: 'team/app',
        } });
        const runner = path.join(dir, 'runner');
        mkdirSync(runner);
        const result = run(runner);
        expect(result.code).toBe(0);
        expect(readdirSync(path.join(runner, 'android-release')).sort()).toEqual(['SillyBunny-android-arm64-v8a.apk', 'SillyBunny-android-armeabi-v7a.apk', 'android-update.json']);
        for (const name of readdirSync(previous)) {
            expect(readFileSync(path.join(runner, 'android-release', name)).equals(readFileSync(path.join(previous, name)))).toBe(true);
        }
        writeFileSync(path.join(previous, 'SillyBunny-android-armeabi-v7a.apk'), randomBytes(1024));
        const tampered = path.join(dir, 'tampered');
        mkdirSync(tampered);
        expect(run(tampered).code).toBe(1);
    });
});

describePosix('the Android release scripts with fake tools (POSIX)', () => {
    let temp;
    beforeAll(() => {
        temp = mkdtempSync(path.join(tmpdir(), 'release-scripts-'));
    });
    afterAll(() => {
        rmSync(temp, { recursive: true, force: true });
    });

    /** A copy of `script` in a minimal checkout, so it never touches this repository's android/ directory. */
    function checkoutWith(name, script, files = {}) {
        const root = path.join(temp, name);
        mkdirSync(path.join(root, 'android', 'release'), { recursive: true });
        copyFileSync(path.join(repoRoot, 'android', 'release', script), path.join(root, 'android', 'release', script));
        for (const [file, content] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            writeFileSync(path.join(root, file), content);
            chmodSync(path.join(root, file), 0o755);
        }
        return root;
    }

    const lastJson = text => JSON.parse(text.trim().split('\n').at(-1));

    test('build-release-apks.sh runs every step in order with only the channel varying, and stops at the first failure', () => {
        const log = path.join(temp, 'build.log');
        const logLine = 'printf \'%s\\n\' "$(basename "$0") $*" >> "$RECIPE_LOG"\n';
        const root = checkoutWith('build', 'build-release-apks.sh', {
            'android/runtime/fetch-termux.sh': logLine,
            'android/runtime/fetch-node.py': logLine,
            'android/runtime/build-npm.py': logLine,
            'android/runtime/build-sources.sh': `${logLine}touch "\${@: -1}"\n`,
            'android/release/check-staged-runtime.mjs': '',
            'android/gradlew': `${logLine}[ -z "$FAIL_GRADLE" ] || exit 7\nfor abi in arm64-v8a armeabi-v7a; do mkdir -p app/build/outputs/apk/release; echo "$abi" > "app/build/outputs/apk/release/app-$abi-release-unsigned.apk"; done\n`,
        });
        const bin = makeBin(path.join(temp, 'build-tools'), {
            java: 'echo "    java.specification.version = ${FAKE_JAVA:-21}" >&2\n',
            python3: '[ "$1 $2" = "-I -B" ] || exit 9\nshift 2\nscript=$1\nshift\nbash "$script" "$@"\n',
            node: `${logLine.replace('$(basename "$0")', 'node')}`,
        });
        const run = (args, env = {}) => {
            writeFileSync(log, '');
            const result = spawnSync('bash', [path.join(root, 'android', 'release', 'build-release-apks.sh'), ...args], {
                encoding: 'utf8', env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: process.env.HOME, RECIPE_LOG: log, ...env },
            });
            return { ...result, log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
        };
        const out = path.join(temp, 'build-out');
        const built = run(['release', out]);
        expect([built.status, built.stderr.includes('TODO(copy)')]).toEqual([0, false]);
        expect(built.log).toEqual([
            'fetch-termux.sh ',
            'fetch-node.py --abi arm64-v8a --abi armeabi-v7a',
            'build-npm.py ',
            `build-sources.sh --require-node --output ${out}/SillyBunny-android-sources.tar.zst`,
            `node ${root}/android/release/check-staged-runtime.mjs`,
            'gradlew --no-daemon --console=plain -PdefaultRef=release :app:assembleRelease',
        ]);
        expect(readdirSync(out).sort()).toEqual(['SillyBunny-android-arm64-v8a-unsigned.apk', 'SillyBunny-android-armeabi-v7a-unsigned.apk', 'SillyBunny-android-sources.tar.zst']);
        expect(run(['staging', path.join(temp, 'build-out-staging')]).log.at(-1)).toBe('gradlew --no-daemon --console=plain -PdefaultRef=staging :app:assembleRelease');

        expect(lastJson(run(['release', out]).stderr)).toEqual({ code: 'output-not-empty', dir: out });
        expect(lastJson(run(['nightly', path.join(temp, 'x')]).stderr)).toEqual({ code: 'invalid-channel', channel: 'nightly' });
        expect(run(['release']).status).toBe(2);
        const signed = run(['release', path.join(temp, 'build-signed')], { ANDROID_KEY_ALIAS: 'release' });
        expect([signed.status, lastJson(signed.stderr), signed.log]).toEqual([1, { code: 'signing-variable-set', name: 'ANDROID_KEY_ALIAS' }, []]);
        expect(lastJson(run(['release', path.join(temp, 'build-jdk')], { FAKE_JAVA: '17' }).stderr)).toEqual({ code: 'jdk-21-required', found: '17' });
        const failed = run(['release', path.join(temp, 'build-failed')], { FAIL_GRADLE: '1' });
        expect([failed.status, lastJson(failed.stderr)]).toEqual([1, { code: 'step-failed', step: 'assemble-release', status: '7' }]);
    });

    const CERT = 'c0'.repeat(32);
    const KEYSTORE = randomBytes(300);
    const FAKE_SDK_TOOLS = {
        aapt2: [
            '[ "$1 $2" = "dump badging" ] || exit 2',
            'abi=$(sed -n \'s/^abi=//p\' "$3")',
            'echo "package: name=\'${FAKE_PACKAGE:-io.github.sillybunnyteam.sillybunny}\' versionCode=\'2\' versionName=\'1.2.0\'"',
            'echo "minSdkVersion:\'29\'"',
            'echo "targetSdkVersion:\'37\'"',
            'if grep -qx debuggable "$3"; then echo application-debuggable; fi',
            'echo "native-code: \'$abi\'"',
            '',
        ].join('\n'),
        zipalign: [
            'printf \'%s\\n\' "zipalign $*" >> "$TOOL_LOG"',
            'if [ "$1" = -c ]; then exit "${FAKE_ALIGN_STATUS:-0}"; fi',
            '[ "$1 $2 $3 $4" = "-P 16 -f 4" ] || exit 2',
            'cp "$5" "$6"',
            '',
        ].join('\n'),
        apksigner: [
            'printf \'%s\\n\' "apksigner $*" >> "$TOOL_LOG"',
            'command=$1',
            'shift',
            'if [ "$command" = sign ]; then',
            '    while [ "$#" -gt 1 ]; do',
            '        case "$1" in',
            '            --out) out=$2; shift 2 ;;',
            '            --ks) keystore=$2; shift 2 ;;',
            '            --ks-pass | --key-pass) variable=${2#env:}; [ -n "${!variable}" ] || exit 8; shift 2 ;;',
            '            *) shift ;;',
            '        esac',
            '    done',
            '    cmp -s "$keystore" "$EXPECTED_KEYSTORE" || exit 7',
            '    stat -c "keystore mode %a" "$keystore" >> "$TOOL_LOG"',
            '    { cat "$1"; echo signed; } > "$out"',
            '    if [ -n "$FAKE_IDSIG" ]; then : > "$out.idsig"; fi',
            '    exit 0',
            'fi',
            'file=${!#}',
            'abi=$(sed -n \'s/^abi=//p\' "$file")',
            'if [ -n "$FAKE_VERIFY_FAIL" ]; then echo "DOES NOT VERIFY"; exit 1; fi',
            'echo Verifies',
            'echo "Verified using v1 scheme (JAR signing): false"',
            'if [ "$2" = 24 ]; then echo "Verified using v2 scheme (APK Signature Scheme v2): true"; exit 0; fi',
            'echo "Verified using v2 scheme (APK Signature Scheme v2): false"',
            'echo "Verified using v3 scheme (APK Signature Scheme v3): true"',
            'echo "Verified using v3.1 scheme (APK Signature Scheme v3.1): false"',
            'echo "Verified using v4 scheme (APK Signature Scheme v4): false"',
            'echo "Number of signers: 1"',
            'cert=$FAKE_CERT',
            'if [ "$abi" = armeabi-v7a ] && [ -n "$FAKE_CERT_V7A" ]; then cert=$FAKE_CERT_V7A; fi',
            'echo "V3.0 Signer: certificate SHA-256 digest: $cert"',
            '',
        ].join('\n'),
    };

    function signSetup(name, { debuggable = false } = {}) {
        const root = checkoutWith(name, 'sign-release-apks.sh', { 'android/app/build.gradle.kts': 'android {\n    buildToolsVersion = "37.0.0"\n}\n' });
        const sdk = path.join(temp, `${name}-sdk`);
        const tools = path.join(sdk, 'build-tools', '37.0.0');
        mkdirSync(tools, { recursive: true });
        for (const [tool, script] of Object.entries(FAKE_SDK_TOOLS)) {
            writeFileSync(path.join(tools, tool), `#!/usr/bin/env bash\n${script}`);
            chmodSync(path.join(tools, tool), 0o755);
        }
        const unsigned = path.join(temp, `${name}-unsigned`);
        mkdirSync(unsigned);
        for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
            writeFileSync(path.join(unsigned, `SillyBunny-android-${abi}-unsigned.apk`), `abi=${abi}\n${debuggable ? 'debuggable\n' : ''}`);
        }
        const expected = path.join(temp, `${name}-keystore`);
        writeFileSync(expected, KEYSTORE);
        const log = path.join(temp, `${name}-tools.log`);
        writeFileSync(log, '');
        const run = (env = {}) => {
            const result = spawnSync('bash', [path.join(root, 'android', 'release', 'sign-release-apks.sh'), unsigned, path.join(temp, `${name}-out`)], {
                encoding: 'utf8',
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    ANDROID_HOME: sdk,
                    TOOL_LOG: log,
                    EXPECTED_KEYSTORE: expected,
                    FAKE_CERT: CERT,
                    ANDROID_KEYSTORE_B64: KEYSTORE.toString('base64').replace(/.{60}/g, '$&\n'),
                    ANDROID_KEYSTORE_PASSWORD: 'store-secret',
                    ANDROID_KEY_ALIAS: 'release',
                    ANDROID_KEY_PASSWORD: 'key-secret',
                    ...env,
                },
            });
            return { ...result, log: readFileSync(log, 'utf8') };
        };
        return { root, sdk, tools, out: path.join(temp, `${name}-out`), keystore: path.join(root, 'android', '.gradle', 'signing', 'release.keystore'), run };
    }

    test('sign-release-apks.sh signs v2 and v3 after zipalign, verifies, prints the certificate and deletes the keystore', () => {
        const setup = signSetup('sign');
        const result = setup.run();
        expect([result.status, result.stderr.includes('TODO(copy)')]).toEqual([0, false]);
        expect(JSON.parse(result.stdout)).toEqual({ signingCertSha256: CERT, minSdk: 29, targetSdk: 37, buildTools: setup.tools });
        expect(readdirSync(setup.out).sort()).toEqual(['SillyBunny-android-arm64-v8a.apk', 'SillyBunny-android-armeabi-v7a.apk']);
        expect(existsSync(setup.keystore)).toBe(false);
        const lines = result.log.trim().split('\n');
        const arm = [
            'zipalign -P 16 -f 4',
            'apksigner sign',
            'keystore mode 600',
            'zipalign -c -P 16 4',
            'apksigner verify --min-sdk-version 29 --max-sdk-version 37 --verbose --print-certs',
            'apksigner verify --min-sdk-version 24 --max-sdk-version 27 --verbose',
        ];
        expect(lines.map(line => arm.find(prefix => line.startsWith(prefix)) ?? line)).toEqual([...arm, ...arm]);
        const sign = lines.find(line => line.startsWith('apksigner sign'));
        expect(sign).toContain('--ks-pass env:ANDROID_KEYSTORE_PASSWORD --ks-key-alias release --key-pass env:ANDROID_KEY_PASSWORD');
        expect(sign).toContain('--v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false');
        expect(result.log).not.toMatch(/store-secret|key-secret/);
        expect(statSync(path.join(setup.out, 'SillyBunny-android-arm64-v8a.apk')).size).toBeGreaterThan(0);
    });

    test('sign-release-apks.sh refuses debuggable or mismatched APKs and failed checks, and never leaves the keystore behind', () => {
        const debuggable = signSetup('sign-debuggable', { debuggable: true });
        const refused = debuggable.run();
        expect([refused.status, lastJson(refused.stderr).code]).toEqual([1, 'apk-debuggable']);
        expect(refused.log).not.toContain('apksigner sign');
        expect(existsSync(debuggable.keystore)).toBe(false);

        const cases = [
            [{ FAKE_VERIFY_FAIL: '1' }, 'verify-failed'],
            [{ FAKE_IDSIG: '1' }, 'v4-signature-written'],
            [{ FAKE_ALIGN_STATUS: '1' }, 'not-aligned'],
            [{ FAKE_CERT_V7A: 'd0'.repeat(32) }, 'certificate-mismatch'],
            [{ FAKE_PACKAGE: 'io.github.other' }, 'apk-package'],
            [{ ANDROID_KEY_PASSWORD: '' }, 'signing-variable-missing'],
            [{ ANDROID_KEYSTORE_B64: '%%%' }, 'keystore-not-base64'],
        ];
        for (const [env, code] of cases) {
            const setup = signSetup(`sign-${code}`);
            const result = setup.run(env);
            expect([code, result.status, lastJson(result.stderr).code]).toEqual([code, 1, code]);
            expect(existsSync(setup.keystore)).toBe(false);
        }

        // A keystore that is already there is someone else's: refused and left alone.
        const existing = signSetup('sign-existing');
        mkdirSync(path.dirname(existing.keystore), { recursive: true });
        writeFileSync(existing.keystore, 'other');
        const kept = existing.run();
        expect([kept.status, lastJson(kept.stderr).code, readFileSync(existing.keystore, 'utf8')]).toEqual([1, 'keystore-exists', 'other']);
    });
});
