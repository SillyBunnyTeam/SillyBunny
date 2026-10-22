#!/usr/bin/env node
// The release build's check of the staged Node and npm payloads (plan §6.2; tracks p4x and p45b).
//
// Usage:
//   node android/release/check-staged-runtime.mjs [--runtime-lock <file>] [--node-out <dir>] [--npm-out <dir>]
//     defaults: android/runtime.lock, android/runtime/node-out and android/runtime/npm-out next to this script
//   Prints a JSON summary. Exit 0 when the staged payloads match the lock; 1 otherwise, with the placeholder and
//   {"code":"staged-runtime-mismatch","problems":[...]} (each problem as stagedRuntimeProblems describes it) on
//   stderr; 2 on a usage error.
//
// Release APKs ship only the Node builds that android-runtime.yml published and android/runtime.lock pins,
// staged by android/runtime/fetch-node.py from their GHCR digests (never --local), and the npm that
// android/runtime/build-npm.py takes from the pinned Node source. So, for the release ABIs:
//   - android/runtime.lock pins Node and npm (unpinnedRuntimePayloads in common.mjs);
//   - node.json has the lock's version; source kind "ghcr" with the lock's repository, patch set and, for exactly
//     the release ABIs, the lock's tags and digests; "abis" lists exactly the release ABIs with the published
//     binaries' SHA-256 and size, and each <abi>/libnode.so has those bytes;
//   - npm.json has the lock's npm version, comes from the Node source of the lock's Node version, and npm.zip
//     has the SHA-256 and size npm.json gives;
//   - node.json and npm.json both name the lock's Node source tarball (filename and SHA-256) as source.tarball.
// The Gradle build compares the same files with the lock too, but only warns about what development builds
// leave out (an unpinned binary, a staging without source attribution).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    isMainModule,
    isPlainObject,
    parseCliArgs,
    RELEASE_ABIS,
    ReleaseToolError,
    runCli,
    sha256File,
    unpinnedRuntimePayloads,
} from './common.mjs';

const releaseDir = path.dirname(fileURLToPath(import.meta.url));

function sameKeys(object, keys) {
    const actual = Object.keys(object).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameJson(actual, expected) {
    return JSON.stringify(actual) === JSON.stringify(expected);
}

function toolError(details) {
    return new ReleaseToolError(`TODO(copy) ${JSON.stringify(details)}`);
}

/**
 * The problems of a staged node.json and npm.json (parsed) against a parsed android/runtime.lock; an empty list
 * when they match. Each problem is an object with a code: "runtime-unpinned" { unpinned }, "not-an-object"
 * { file }, "mismatch" { file, field, actual, expected } or "invalid" { file, field, actual }. A malformed lock
 * throws a ReleaseToolError.
 */
export function stagedRuntimeProblems({ runtimeLock, nodeJson, npmJson, abis = RELEASE_ABIS }) {
    const unpinned = unpinnedRuntimePayloads(runtimeLock);
    if (unpinned.length > 0) {
        return [{ code: 'runtime-unpinned', unpinned }];
    }
    const problems = [];
    const expect = (file, field, actual, expected, matches = sameJson(actual, expected)) => {
        if (!matches) {
            problems.push({ code: 'mismatch', file, field, actual: actual ?? null, expected });
        }
    };
    const node = runtimeLock.node;
    const binaries = abis.map(abi => [abi, node.binaries[abi]]);
    const tarball = { filename: node.source.tarball, sha256: node.source.tarballSha256 };
    const pinnedTarball = value => (isPlainObject(value) ? { filename: value.filename, sha256: value.sha256 } : value);

    if (!isPlainObject(nodeJson)) {
        problems.push({ code: 'not-an-object', file: 'node.json' });
    } else {
        expect('node.json', 'schema', nodeJson.schema, 1);
        expect('node.json', 'version', nodeJson.version, node.version);
        const source = isPlainObject(nodeJson.source) ? nodeJson.source : {};
        // A release ships only the Node builds fetch-node.py stages from the pinned GHCR digests, never --local ones.
        expect('node.json', 'source.kind', source.kind, 'ghcr');
        const repositories = [...new Set(binaries.map(([, binary]) => binary.repository))].sort();
        expect('node.json', 'source.repository', source.repository, repositories.length === 1 ? repositories[0] : repositories);
        expect('node.json', 'source.patchSetSha256', source.patchSetSha256, node.patchSet?.sha256 ?? null);
        const artifacts = isPlainObject(source.artifacts) ? source.artifacts : {};
        expect('node.json', 'source.artifacts', Object.keys(artifacts).sort(), [...abis].sort(), sameKeys(artifacts, abis));
        const staged = isPlainObject(nodeJson.abis) ? nodeJson.abis : {};
        expect('node.json', 'abis', Object.keys(staged).sort(), [...abis].sort(), sameKeys(staged, abis));
        for (const [abi, binary] of binaries) {
            const artifact = isPlainObject(artifacts[abi]) ? { tag: artifacts[abi].tag, digest: artifacts[abi].digest } : artifacts[abi];
            expect('node.json', `source.artifacts.${abi}`, artifact, { tag: binary.tag, digest: binary.digest });
            const record = isPlainObject(staged[abi]) ? { sha256: staged[abi].sha256, size: staged[abi].size } : staged[abi];
            expect('node.json', `abis.${abi}`, record, { sha256: binary.sha256, size: binary.size });
        }
        expect('node.json', 'source.tarball', pinnedTarball(source.tarball), tarball);
    }

    if (!isPlainObject(npmJson)) {
        problems.push({ code: 'not-an-object', file: 'npm.json' });
    } else {
        expect('npm.json', 'schema', npmJson.schema, 1);
        expect('npm.json', 'version', npmJson.version, runtimeLock.npm.version);
        const source = isPlainObject(npmJson.source) ? npmJson.source : {};
        expect('npm.json', 'source.kind', source.kind, 'node-source-tarball');
        expect('npm.json', 'source.node', source.node, node.version);
        expect('npm.json', 'source.tarball', pinnedTarball(source.tarball), tarball);
        if (!(typeof npmJson.sha256 === 'string' && /^[0-9a-f]{64}$/.test(npmJson.sha256))) {
            problems.push({ code: 'invalid', file: 'npm.json', field: 'sha256', actual: npmJson.sha256 ?? null });
        }
        if (!(Number.isSafeInteger(npmJson.size) && npmJson.size > 0)) {
            problems.push({ code: 'invalid', file: 'npm.json', field: 'size', actual: npmJson.size ?? null });
        }
    }
    return problems;
}

function readJson(file, what) {
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch (error) {
        throw toolError({ code: 'unreadable', file: what, path: file, error: error.code ?? error.message });
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw toolError({ code: 'invalid-json', file: what, path: file, error: error.message });
    }
}

/** Problems of the staged files against the records node.json and npm.json give for them. */
async function stagedFileProblems({ nodeOut, npmOut, nodeJson, npmJson, abis = RELEASE_ABIS }) {
    const files = [
        ...abis.map(abi => [`${abi}/libnode.so`, path.join(nodeOut, abi, 'libnode.so'), nodeJson.abis[abi]]),
        ['npm.zip', path.join(npmOut, 'npm.zip'), { sha256: npmJson.sha256, size: npmJson.size }],
    ];
    const problems = [];
    for (const [name, file, record] of files) {
        let measured;
        try {
            measured = await sha256File(file);
        } catch (error) {
            problems.push({ code: 'unreadable', file: name, error: error.code ?? error.message });
            continue;
        }
        if (measured.sha256 !== record.sha256 || measured.size !== record.size) {
            problems.push({ code: 'mismatch', file: name, field: 'bytes', actual: measured, expected: { sha256: record.sha256, size: record.size } });
        }
    }
    return problems;
}

async function main(argv) {
    const values = parseCliArgs(argv, {
        'runtime-lock': { type: 'string' },
        'node-out': { type: 'string' },
        'npm-out': { type: 'string' },
    });
    const lockFile = values['runtime-lock'] ?? path.join(releaseDir, '..', 'runtime.lock');
    const nodeOut = values['node-out'] ?? path.join(releaseDir, '..', 'runtime', 'node-out');
    const npmOut = values['npm-out'] ?? path.join(releaseDir, '..', 'runtime', 'npm-out');
    const runtimeLock = readJson(lockFile, 'android/runtime.lock');
    const nodeJson = readJson(path.join(nodeOut, 'node.json'), 'node.json');
    const npmJson = readJson(path.join(npmOut, 'npm.json'), 'npm.json');
    let problems = stagedRuntimeProblems({ runtimeLock, nodeJson, npmJson });
    if (problems.length === 0) {
        problems = await stagedFileProblems({ nodeOut, npmOut, nodeJson, npmJson });
    }
    if (problems.length > 0) {
        throw toolError({ code: 'staged-runtime-mismatch', problems });
    }
    process.stdout.write(`${JSON.stringify({
        node: nodeJson.version,
        npm: npmJson.version,
        abis: RELEASE_ABIS,
        source: nodeJson.source.kind,
        tarball: nodeJson.source.tarball.filename,
    })}\n`);
}

if (isMainModule(import.meta.url)) {
    await runCli('check-staged-runtime', main);
}
