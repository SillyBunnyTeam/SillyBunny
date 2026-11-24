#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const MARKER_VERSION = 1;
const MARKER_PATH = path.join(process.cwd(), 'node_modules', '.sillybunny-dependencies.json');
const STATE_FILES = [
    'package.json',
    'bun.lock',
    'package-lock.json',
];
const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'));

function hashFileState(profile) {
    const hash = crypto.createHash('sha256');
    hash.update(`version:${MARKER_VERSION}\n`);
    hash.update(`profile:${profile}\n`);
    hash.update(`node_env:${process.env.NODE_ENV || ''}\n`);

    for (const file of STATE_FILES) {
        const filePath = path.join(process.cwd(), file);
        hash.update(`file:${file}\n`);

        if (!fs.existsSync(filePath)) {
            hash.update('missing\n');
            continue;
        }

        hash.update(fs.readFileSync(filePath));
        hash.update('\n');
    }

    return hash.digest('hex');
}

function readMarker() {
    try {
        return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
    } catch {
        return { version: MARKER_VERSION, profiles: {} };
    }
}

function writeMarker(marker) {
    fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
    fs.writeFileSync(`${MARKER_PATH}.tmp`, `${JSON.stringify(marker, null, 4)}\n`);
    fs.renameSync(`${MARKER_PATH}.tmp`, MARKER_PATH);
}

function getRuntimeVersion(profile) {
    if (profile.startsWith('bun')) {
        return globalThis.Bun?.version || '';
    }

    if (profile.startsWith('node')) {
        return process.versions.node || '';
    }

    return '';
}

function getCurrentState(profile) {
    return {
        hash: hashFileState(profile),
        runtimeVersion: getRuntimeVersion(profile),
        markedAt: new Date().toISOString(),
    };
}

function readPackageJson(packageName, baseRequire = requireFromCwd) {
    try {
        const packageJsonPath = baseRequire.resolve(`${packageName}/package.json`);
        return {
            path: packageJsonPath,
            data: JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')),
        };
    } catch {
        return null;
    }
}

function getFirstMajor(rangeOrVersion) {
    return String(rangeOrVersion || '').match(/\d+/)?.[0] || '';
}

function getPackageDependencyIssue(parent, dependencyName, parentLabel) {
    const expectedRange = parent.data?.dependencies?.[dependencyName];
    const expectedMajor = getFirstMajor(expectedRange);
    if (!expectedMajor) {
        return '';
    }

    const parentRequire = createRequire(parent.path);
    const resolved = readPackageJson(dependencyName, parentRequire);
    const actualMajor = getFirstMajor(resolved?.data?.version);

    if (actualMajor !== expectedMajor) {
        return `${parentLabel} resolved ${dependencyName} ${resolved?.data?.version || 'missing'} but requires ${expectedRange}`;
    }

    return '';
}

function getRuntimeInstallIssue() {
    const express = readPackageJson('express');

    if (!express) {
        return 'runtime dependencies are missing';
    }

    const checkedSendPaths = new Set();
    const expressRequire = createRequire(express.path);

    if (express.data?.dependencies?.send) {
        const send = readPackageJson('send', expressRequire);

        if (!send) {
            return 'Express dependency send is missing';
        }

        checkedSendPaths.add(send.path);
        const sendMimeIssue = getPackageDependencyIssue(send, 'mime', 'send');
        if (sendMimeIssue) {
            return sendMimeIssue;
        }
    }

    if (express.data?.dependencies?.['serve-static']) {
        const serveStatic = readPackageJson('serve-static', expressRequire);

        if (!serveStatic) {
            return 'Express dependency serve-static is missing';
        }

        if (serveStatic.data?.dependencies?.send) {
            const serveStaticRequire = createRequire(serveStatic.path);
            const send = readPackageJson('send', serveStaticRequire);

            if (!send) {
                return 'serve-static dependency send is missing';
            }

            if (!checkedSendPaths.has(send.path)) {
                const sendMimeIssue = getPackageDependencyIssue(send, 'mime', 'send');
                if (sendMimeIssue) {
                    return sendMimeIssue;
                }
            }
        }
    }

    return '';
}

function getDevelopmentInstallIssue() {
    const eslintrc = readPackageJson('@eslint/eslintrc');

    if (!eslintrc) {
        return 'development lint dependencies are missing';
    }

    return getPackageDependencyIssue(eslintrc, 'ajv', 'ESLint');
}

function needsInstall(profile) {
    if (!fs.existsSync(path.join(process.cwd(), 'node_modules'))) {
        return 'node_modules is missing';
    }

    if (!fs.existsSync(path.join(process.cwd(), 'config.yaml'))) {
        return 'config.yaml is missing';
    }

    const runtimeInstallIssue = getRuntimeInstallIssue();
    if (runtimeInstallIssue) {
        return runtimeInstallIssue;
    }

    if (profile.endsWith('-development')) {
        const developmentInstallIssue = getDevelopmentInstallIssue();

        if (developmentInstallIssue) {
            return developmentInstallIssue;
        }
    }

    const marker = readMarker();
    const expectedHash = hashFileState(profile);
    const profileState = marker?.profiles?.[profile];

    if (marker.version !== MARKER_VERSION || !profileState || profileState.hash !== expectedHash) {
        return 'dependency state changed';
    }

    return '';
}

function markInstalled(profile) {
    const marker = readMarker();
    marker.version = MARKER_VERSION;
    marker.profiles = marker.profiles || {};
    marker.profiles[profile] = getCurrentState(profile);
    writeMarker(marker);
}

function printUsage() {
    console.error('Usage: dependency-state.js <check|mark> <profile>');
}

const [command, profile] = process.argv.slice(2);

if (!command || !profile) {
    printUsage();
    process.exit(2);
}

if (command === 'check') {
    const reason = needsInstall(profile);

    if (reason) {
        if (process.env.SILLYBUNNY_DEPENDENCY_DEBUG) {
            console.log(`Dependency install required: ${reason}.`);
        }

        process.exit(1);
    }

    process.exit(0);
}

if (command === 'mark') {
    markInstalled(profile);
    process.exit(0);
}

printUsage();
process.exit(2);
