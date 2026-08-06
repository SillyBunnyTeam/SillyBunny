import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import fetch from 'node-fetch';
import yauzl from 'yauzl';

import { isPathInside } from './path-containment.js';

const GITHUB_OWNER = 'platberlitz';
const GITHUB_REPO = 'SillyBunny';
const GITHUB_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_RELEASE_DOWNLOAD_PREFIX = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/`;
const RELEASE_ZIP_PREFIX = 'SillyBunny-v';
const RELEASE_ZIP_SUFFIX = '-github.zip';
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'SillyBunny ZIP updater';

function normalizeVersion(value) {
    return String(value ?? '').trim().replace(/^v/i, '');
}

function parseVersion(value) {
    const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);

    if (!match) {
        return null;
    }

    return match.slice(1, 4).map(part => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
    const leftParts = parseVersion(left);
    const rightParts = parseVersion(right);

    if (!leftParts || !rightParts) {
        return null;
    }

    for (let index = 0; index < leftParts.length; index++) {
        if (leftParts[index] > rightParts[index]) {
            return 1;
        }
        if (leftParts[index] < rightParts[index]) {
            return -1;
        }
    }

    return 0;
}

function buildReleaseZipAssetName(version) {
    return `${RELEASE_ZIP_PREFIX}${normalizeVersion(version)}${RELEASE_ZIP_SUFFIX}`;
}

function createTimeoutSignal() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return {
        signal: controller.signal,
        clear: () => clearTimeout(timeout),
    };
}

async function fetchWithTimeout(url, options = {}) {
    const timeout = createTimeoutSignal();

    try {
        return await fetch(url, {
            ...options,
            signal: timeout.signal,
            headers: {
                'Accept': 'application/vnd.github+json',
                'User-Agent': USER_AGENT,
                ...(options.headers ?? {}),
            },
        });
    } finally {
        timeout.clear();
    }
}

async function fetchLatestRelease() {
    const response = await fetchWithTimeout(GITHUB_RELEASE_API_URL);

    if (!response.ok) {
        throw new Error(`GitHub release check failed with HTTP ${response.status}.`);
    }

    return await response.json();
}

function validateReleaseAssetUrl(assetUrl, version) {
    const parsedUrl = new URL(String(assetUrl ?? ''));
    const assetName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '');

    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
        throw new Error('Release ZIP download URL did not come from github.com over HTTPS.');
    }

    if (!parsedUrl.pathname.startsWith(GITHUB_RELEASE_DOWNLOAD_PREFIX)) {
        throw new Error(`Release ZIP download URL does not match ${GITHUB_OWNER}/${GITHUB_REPO}.`);
    }

    if (assetName !== buildReleaseZipAssetName(version)) {
        throw new Error(`Release ZIP asset must be named ${buildReleaseZipAssetName(version)}.`);
    }

    return parsedUrl.toString();
}

function createBaseReleaseStatus(currentVersion) {
    return {
        supported: true,
        checked: false,
        currentVersion: normalizeVersion(currentVersion),
        latestVersion: '',
        releaseName: '',
        releaseUrl: '',
        assetName: '',
        assetUrl: '',
        assetAvailable: false,
        canUpdate: false,
        message: '',
    };
}

export async function getLatestZipReleaseStatus(currentVersion) {
    const status = createBaseReleaseStatus(currentVersion);

    try {
        const release = await fetchLatestRelease();
        const latestVersion = normalizeVersion(release?.tag_name || release?.name);
        const assetName = buildReleaseZipAssetName(latestVersion);
        const asset = Array.isArray(release?.assets)
            ? release.assets.find(item => item?.name === assetName)
            : null;
        const comparison = compareVersions(latestVersion, status.currentVersion);

        status.checked = true;
        status.latestVersion = latestVersion;
        status.releaseName = String(release?.name ?? release?.tag_name ?? '').trim();
        status.releaseUrl = String(release?.html_url ?? '').trim();
        status.assetName = assetName;

        if (!parseVersion(latestVersion)) {
            status.message = 'The latest GitHub release does not use a supported vX.Y.Z version tag.';
            return status;
        }

        if (!asset) {
            status.message = `Latest GitHub release v${latestVersion} does not include ${assetName}.`;
            return status;
        }

        status.assetUrl = validateReleaseAssetUrl(asset.browser_download_url, latestVersion);
        status.assetAvailable = true;

        if (comparison === null) {
            status.message = 'Could not compare the installed version with the latest GitHub release.';
        } else if (comparison > 0) {
            status.canUpdate = true;
            status.message = `ZIP release v${latestVersion} is available.`;
        } else if (comparison === 0) {
            status.message = `Latest ZIP release v${latestVersion} is already installed.`;
        } else {
            status.message = `Installed version v${status.currentVersion} is newer than latest ZIP release v${latestVersion}.`;
        }
    } catch (error) {
        status.checked = false;
        status.canUpdate = false;
        status.message = error?.name === 'AbortError'
            ? 'GitHub release check timed out.'
            : error?.message || 'Failed to check GitHub releases.';
    }

    return status;
}

function getSafeZipEntryPath(fileName) {
    const rawName = String(fileName ?? '').replaceAll('\\', '/');

    if (!rawName || rawName.includes('\0') || rawName.startsWith('/')) {
        throw new Error(`Unsafe ZIP entry path: ${fileName}`);
    }

    const parts = rawName.split('/').filter(Boolean);

    if (parts.some(part => part === '.' || part === '..' || part.includes(':'))) {
        throw new Error(`Unsafe ZIP entry path: ${fileName}`);
    }

    return parts.join(path.sep);
}

function openZip(zipPath) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (error, zipFile) => {
            if (error || !zipFile) {
                reject(error || new Error('Failed to open release ZIP.'));
                return;
            }

            resolve(zipFile);
        });
    });
}

function getZipMode(entry, fallback) {
    const mode = (entry.externalFileAttributes >>> 16) & 0o777;
    return mode || fallback;
}

async function extractZip(zipPath, destination) {
    const root = path.resolve(destination);
    const zipFile = await openZip(zipPath);

    await new Promise((resolve, reject) => {
        let finished = false;

        function fail(error) {
            if (finished) {
                return;
            }
            finished = true;
            zipFile.close();
            reject(error);
        }

        zipFile.once('error', fail);
        zipFile.once('end', () => {
            if (!finished) {
                finished = true;
                resolve();
            }
        });

        zipFile.on('entry', entry => {
            let relativePath = '';

            try {
                relativePath = getSafeZipEntryPath(entry.fileName);
            } catch (error) {
                fail(error);
                return;
            }

            if (!relativePath) {
                zipFile.readEntry();
                return;
            }

            const targetPath = path.resolve(root, relativePath);

            if (!isPathInside(root, targetPath, { allowEqual: true })) {
                fail(new Error(`ZIP entry escapes the extraction directory: ${entry.fileName}`));
                return;
            }

            if (entry.fileName.endsWith('/')) {
                fs.mkdirSync(targetPath, { recursive: true, mode: getZipMode(entry, 0o755) });
                zipFile.readEntry();
                return;
            }

            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            zipFile.openReadStream(entry, (error, readStream) => {
                if (error || !readStream) {
                    fail(error || new Error(`Failed to read ZIP entry: ${entry.fileName}`));
                    return;
                }

                pipeline(readStream, fs.createWriteStream(targetPath, { mode: getZipMode(entry, 0o644) }))
                    .then(() => {
                        fs.chmodSync(targetPath, getZipMode(entry, 0o644));
                        zipFile.readEntry();
                    })
                    .catch(fail);
            });
        });

        zipFile.readEntry();
    });
}

function resolveReleaseRoot(extractRoot) {
    const entries = fs.readdirSync(extractRoot, { withFileTypes: true })
        .filter(entry => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');

    if (entries.length === 1 && entries[0].isDirectory()) {
        return path.join(extractRoot, entries[0].name);
    }

    return extractRoot;
}

function validateExtractedRelease(releaseRoot, version) {
    const packageJsonPath = path.join(releaseRoot, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
        throw new Error('Release ZIP did not contain package.json at the app root.');
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const packageVersion = normalizeVersion(packageJson?.version);

    if (packageVersion !== normalizeVersion(version)) {
        throw new Error(`Release ZIP package.json version is v${packageVersion}, expected v${normalizeVersion(version)}.`);
    }

    return {
        name: String(packageJson?.name ?? '').trim(),
        version: packageVersion,
    };
}

async function downloadReleaseAsset(assetUrl, zipPath) {
    const response = await fetchWithTimeout(assetUrl, { headers: { Accept: 'application/octet-stream' } });

    if (!response.ok || !response.body) {
        throw new Error(`Release ZIP download failed with HTTP ${response.status}.`);
    }

    await pipeline(response.body, fs.createWriteStream(zipPath));

    const stats = fs.statSync(zipPath);
    if (!stats.isFile() || stats.size <= 0) {
        throw new Error('Downloaded release ZIP was empty.');
    }
}

export async function stageZipReleaseUpdate(releaseStatus) {
    const latestVersion = normalizeVersion(releaseStatus?.latestVersion);
    const assetName = buildReleaseZipAssetName(latestVersion);
    const assetUrl = validateReleaseAssetUrl(releaseStatus?.assetUrl, latestVersion);
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sillybunny-zip-update-'));
    const zipPath = path.join(stagingRoot, assetName);
    const extractRoot = path.join(stagingRoot, 'extract');

    try {
        fs.mkdirSync(extractRoot, { recursive: true });
        await downloadReleaseAsset(assetUrl, zipPath);
        await extractZip(zipPath, extractRoot);

        const releaseRoot = resolveReleaseRoot(extractRoot);
        const packageInfo = validateExtractedRelease(releaseRoot, latestVersion);

        return {
            stagingRoot,
            zipPath,
            extractRoot,
            releaseRoot,
            version: latestVersion,
            assetName,
            packageInfo,
        };
    } catch (error) {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        throw error;
    }
}
