/**
 * Constants and pure helpers of the Android smoke (plan §7.1). This module needs nothing beyond Node itself,
 * so CI can run `run-smoke.js guard`, `gradle-args` and `apk-check` before the tests package is installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTENSION_REPO, PLUGIN_REPO, SILLYBUNNY_REPO } from './repos.js';
import { StepError } from './smoke-runner.js';
import { MANIFEST_NAME, RELEASES_INDEX_NAME } from './update-manifest.js';

/** The repository this file belongs to. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The debug build's application id. */
export const DEFAULT_PACKAGE = 'io.github.sillybunnyteam.sillybunny.debug';
export const MAIN_ACTIVITY = 'io.github.sillybunnyteam.sillybunny.MainActivity';
export const SMOKE_TEST_CLASS = 'io.github.sillybunnyteam.sillybunny.smoke.SmokeUiTest';

/**
 * Guest ports baked into the test APK's fixture URLs. They sit inside the fixture range and below the
 * app's own server ports (PortPolicy.RANGE 49152-65535); `adb reverse` maps each to its fixture's random
 * host port, so one APK serves every run and every device.
 */
export const GUEST_PORTS = Object.freeze({ git: 38411, llm: 38412, update: 38413 });

/** App-relative paths (run-as starts in the app's data directory). */
export const CHECKOUT_DIR = 'files/SillyBunny';
export const DATA_DIR = `${CHECKOUT_DIR}/data`;
export const BLOCKED_STATUS_FILE = 'files/status/update-blocked.json';
export const SERVER_LOG_FILE = 'files/logs/server.log';

/**
 * The notification PackageReplacedReceiver posts after an update. It must match the app's
 * UpdateNotifications.REPLACED_ID and UpdateNotifications.CHANNEL_ID.
 */
export const UPDATE_REPLACED_NOTIFICATION = Object.freeze({ id: 5801, channel: 'app_updates' });

/**
 * Tags of screens that task 5.5 (track p5int) wires into MainActivity. They are run options, so stage B
 * can confirm them against the integrated app without code changes.
 */
export const DEFAULT_UI_TAGS = Object.freeze({
    openSettings: 'app_open_settings',
    failedRestart: 'app_failed_restart',
    failedShareLogs: 'app_failed_share_logs',
});

/**
 * The fixture URLs as the app sees them (guest 127.0.0.1 and the fixed guest ports).
 * @param {{git: number, llm: number, update: number}} [ports] Guest ports.
 * @returns {{repo: string, extension: string, plugin: string, llmBase: string, updateBase: string, manifest: string, releases: string}} URLs.
 */
export function guestUrls(ports = GUEST_PORTS) {
    const updateBase = `http://127.0.0.1:${ports.update}`;
    return {
        repo: `http://127.0.0.1:${ports.git}/${SILLYBUNNY_REPO}`,
        extension: `http://127.0.0.1:${ports.git}/${EXTENSION_REPO}`,
        plugin: `http://127.0.0.1:${ports.git}/${PLUGIN_REPO}`,
        llmBase: `http://127.0.0.1:${ports.llm}/v1`,
        updateBase,
        manifest: `${updateBase}/${MANIFEST_NAME}`,
        releases: `${updateBase}/${RELEASES_INDEX_NAME}`,
    };
}

/**
 * The Gradle properties of the test APK (the debug build's fixture URL overrides).
 * @param {{git: number, llm: number, update: number}} [ports] Guest ports.
 * @returns {{debugRepoUrl: string, debugUpdateManifestUrl: string, debugReleasesApiUrl: string}} Properties.
 */
export function gradleProperties(ports = GUEST_PORTS) {
    const urls = guestUrls(ports);
    return { debugRepoUrl: urls.repo, debugUpdateManifestUrl: urls.manifest, debugReleasesApiUrl: urls.releases };
}

/**
 * Version and runtime facts of the checkout the APK was built from.
 * @param {string} root Repository root.
 * @returns {{versionCode: number, versionName: string, runtime: {node: string, npm: string, git: string, bash: string}}} Facts.
 */
export function readRepositoryFacts(root) {
    const properties = {};
    for (const line of fs.readFileSync(path.join(root, 'android', 'app-version.properties'), 'utf8').split(/\r?\n/)) {
        const match = /^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) {
            properties[match[1]] = match[2];
        }
    }
    const versionCode = Number(properties.versionCode);
    if (!Number.isSafeInteger(versionCode) || versionCode <= 0 || !properties.versionName) {
        throw new Error('android/app-version.properties must hold versionCode and versionName.');
    }
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'android', 'runtime.lock'), 'utf8'));
    const termux = name => lock.termux?.packages?.find(item => item.name === name)?.version;
    const runtime = { node: lock.node?.version, npm: lock.npm?.version, git: termux('git'), bash: termux('bash') };
    for (const [name, version] of Object.entries(runtime)) {
        if (typeof version !== 'string' || version === '') {
            throw new Error(`android/runtime.lock has no ${name} version.`);
        }
    }
    return { versionCode, versionName: properties.versionName, runtime };
}

/**
 * Sets one top-level boolean in config.yaml text, keeping everything else byte for byte.
 * @param {string} text config.yaml.
 * @param {string} key Top-level key that already exists.
 * @param {boolean} value Value.
 * @returns {string} New text.
 */
export function setConfigFlag(text, key, value) {
    const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[^\\S\\r\\n]*(true|false)[^\\S\\r\\n]*(#.*)?$`, 'm');
    if (!pattern.test(text)) {
        throw new StepError('config-key-missing', `config.yaml has no top-level boolean ${key}`);
    }
    return text.replace(pattern, (line, _old, comment) => `${key}: ${value}${comment ? ` ${comment}` : ''}`);
}

/**
 * Resolves `.git/HEAD` to a commit with the loose ref or `packed-refs`.
 * @param {object} files Contents read from the checkout.
 * @param {string|null} files.head `.git/HEAD`.
 * @param {(ref: string) => string|null} files.looseRef Reads `.git/<ref>`.
 * @param {string|null} files.packedRefs `.git/packed-refs`.
 * @returns {{branch: string|null, commit: string|null}} HEAD.
 */
export function resolveHead({ head, looseRef, packedRefs }) {
    const text = String(head ?? '').trim();
    if (/^[0-9a-f]{40}$/.test(text)) {
        return { branch: null, commit: text };
    }
    const match = /^ref: (refs\/heads\/(\S+))$/.exec(text);
    if (!match) {
        return { branch: null, commit: null };
    }
    const loose = looseRef(match[1]);
    if (loose && /^[0-9a-f]{40}$/.test(loose.trim())) {
        return { branch: match[2], commit: loose.trim() };
    }
    for (const line of String(packedRefs ?? '').split(/\r?\n/)) {
        const packed = /^([0-9a-f]{40}) (\S+)$/.exec(line);
        if (packed && packed[2] === match[1]) {
            return { branch: match[2], commit: packed[1] };
        }
    }
    return { branch: match[2], commit: null };
}

/**
 * Entry names of a ZIP file (APK) from its central directory.
 * @param {Buffer} zip File contents.
 * @returns {string[]} Names.
 */
export function zipEntryNames(zip) {
    const minimum = Math.max(0, zip.length - 22 - 0xffff);
    let end = -1;
    for (let offset = zip.length - 22; offset >= minimum; offset--) {
        if (zip.readUInt32LE(offset) === 0x06054b50) {
            end = offset;
            break;
        }
    }
    if (end < 0) {
        throw new Error('Not a ZIP file: no end of central directory.');
    }
    const count = zip.readUInt16LE(end + 10);
    let offset = zip.readUInt32LE(end + 16);
    const names = [];
    for (let index = 0; index < count; index++) {
        if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('Corrupt ZIP central directory.');
        }
        const nameLength = zip.readUInt16LE(offset + 28);
        const extraLength = zip.readUInt16LE(offset + 30);
        const commentLength = zip.readUInt16LE(offset + 32);
        names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return names;
}

/**
 * Entries that would ship a Bun binary or link (step 13): a path segment named bun, bunx, libbun.so,
 * libbunx.so or a `bun-<version>` folder. Names that merely contain "bun" (bundle.js, sillybunny) pass.
 * @param {string[]} names Entry names.
 * @returns {string[]} Offending names.
 */
export function bunEntries(names) {
    const segment = /^(?:lib)?bunx?(?:\.so|\.exe)?$|^bun-v?\d/i;
    return names.filter(name => name.split('/').some(part => segment.test(part)));
}
