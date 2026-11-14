import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encode } from '../lib/codec.js';
import { isDerived } from '../lib/derive.js';
import { MANIFEST_PATH, outputsOf, readManifest } from '../lib/manifest.js';
import { REPO_ROOT } from './pictures.js';

/**
 * A scratch folder that is removed when the test ends, passed or not.
 * @param {import('node:test').TestContext} t
 */
export function tempDir(t, prefix = 'sb-art-') {
    const folder = mkdtempSync(join(tmpdir(), prefix));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    return folder;
}

/**
 * A scratch checkout with the art folder and every output of a derived asset, so a test can write without touching the
 * real checkout.
 * @param {import('node:test').TestContext} t
 */
export function copyOfArt(t) {
    const root = tempDir(t, 'sb-art-copy-');
    cpSync(join(REPO_ROOT, 'assets-src/art'), join(root, 'assets-src/art'), { recursive: true });
    const { manifest } = readManifest(REPO_ROOT);
    for (const asset of Object.values(manifest.assets).filter(isDerived)) {
        for (const { path } of outputsOf(asset)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            cpSync(join(REPO_ROOT, path), join(root, path));
        }
    }
    return root;
}

/**
 * A scratch checkout made of the given files. A raster is written as PNG, an object as JSON, a string as it is.
 * @param {import('node:test').TestContext} t
 * @param {Record<string, import('../lib/raster.js').Raster | Buffer | string | object>} files Paths relative to the root.
 */
export async function fixtureRepo(t, files) {
    const root = tempDir(t, 'sb-art-fixture-');
    for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), await toBytes(content));
    }
    return root;
}

/** Writes a manifest into a scratch checkout as the CLI writes it. */
export function writeFixtureManifest(root, manifest) {
    writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 4)}\n`);
}

async function toBytes(content) {
    if (typeof content === 'string' || Buffer.isBuffer(content)) {
        return content;
    }
    if (content?.data && Number.isInteger(content.width)) {
        return encode(content, 'png');
    }
    return `${JSON.stringify(content, null, 4)}\n`;
}
