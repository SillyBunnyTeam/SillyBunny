/**
 * What the two emoji scripts share: reading the pins of `sources.json`, downloading an input and checking it against its
 * pin, unpacking it, and the manifest. Nothing here installs a package: the inputs are fetched by address and checked by
 * hash, so `.npmrc` (`ignore-scripts`, `min-release-age`, the `allow-*` lines) is not involved.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sources = JSON.parse(readFileSync(path.join(repositoryRoot, 'scripts/emoji/sources.json'), 'utf8'));
export const manifestPath = path.join(repositoryRoot, 'scripts/emoji/manifest.json');

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The directory that `tar` unpacks into, and that the caller removes when it is done. */
export function makeWorkDirectory(label) {
    return mkdtempSync(path.join(tmpdir(), `sb-emoji-${label}-`));
}

export async function download(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/** Stops with both values when a download is not the pinned one. Nothing is written before this passes. */
export function expect(label, actual, wanted) {
    if (actual !== wanted) {
        throw new Error(`${label} is not the pinned one.\n  pinned: ${wanted}\n  found:  ${actual}`);
    }
}

export function unpackTarball(bytes, directory) {
    mkdirSync(directory, { recursive: true });
    const archive = path.join(directory, 'archive.tgz');
    writeFileSync(archive, bytes);
    execFileSync('tar', ['-xzf', archive, '-C', directory]);
    rmSync(archive);
}

/** The emojibase tarball, checked by its `sha512` integrity, its `sha1` and its length, unpacked into `directory`. Returns the package directory. */
export async function fetchEmojibase(directory) {
    const pin = sources.emojibase;
    const bytes = await download(pin.tarball);
    expect('The emojibase-data tarball size', bytes.length, pin.bytes);
    expect('The emojibase-data integrity', `sha512-${createHash('sha512').update(bytes).digest('base64')}`, pin.integrity);
    expect('The emojibase-data shasum', createHash('sha1').update(bytes).digest('hex'), pin.shasum);
    unpackTarball(bytes, directory);
    const packageDirectory = path.join(directory, 'package');
    expect('The emojibase licence', sha256(readFileSync(path.join(packageDirectory, 'LICENSE'))), pin.licenseSha256);
    return packageDirectory;
}

/** The Unicode License V3 text, checked by its sha256. */
export async function fetchUnicodeLicense() {
    const bytes = await download(sources.unicodeLicense.url);
    expect('The Unicode licence', sha256(bytes), sources.unicodeLicense.sha256);
    return bytes;
}

/**
 * sha256 over the sorted lines `<name> <sha256 of the file>` of a directory. It decides that the Twemoji files are the
 * pinned ones, because GitHub does not promise that an archive keeps its bytes.
 */
export function treeDigest(directory) {
    const lines = readdirSync(directory).sort().map(name => `${name} ${sha256(readFileSync(path.join(directory, name)))}\n`);
    return { files: lines.length, sha256: sha256(lines.join('')) };
}

/** The Twemoji archive unpacked into `directory`; the answer is the directory of its SVGs and the graphics licence text. */
export async function fetchTwemoji(directory) {
    const pin = sources.twemoji;
    const bytes = await download(pin.archive);
    if (sha256(bytes) !== pin.archiveSha256) {
        console.warn('The Twemoji archive differs from the pinned bytes; the tree digest below decides.');
    }
    unpackTarball(bytes, directory);
    const top = readdirSync(directory).find(name => name.startsWith('twemoji-'));
    const svgDirectory = path.join(directory, top, 'assets', 'svg');
    const digest = treeDigest(svgDirectory);
    expect('The number of Twemoji SVG files', digest.files, pin.svgFiles);
    expect('The digest of the Twemoji SVG files', digest.sha256, pin.svgTreeSha256);
    const license = readFileSync(path.join(directory, top, 'LICENSE-GRAPHICS'));
    expect('The Twemoji graphics licence', sha256(license), pin.graphicsLicenseSha256);
    return { svgDirectory, license };
}

export function readManifest() {
    try {
        return JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
        return {};
    }
}

/** Writes one section of the manifest (`data` or `font`) and leaves the other as it is; keys are sorted so that a rerun is byte-identical. */
export function writeManifestSection(name, section) {
    const manifest = { ...readManifest(), [name]: section };
    const ordered = Object.fromEntries(Object.keys(manifest).sort().map(key => [key, manifest[key]]));
    writeFileSync(manifestPath, `${JSON.stringify(ordered, null, 4)}\n`);
}
