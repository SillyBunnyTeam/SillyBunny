import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEY_GROUPS, outputsOf } from './manifest.js';
import { sha256 } from './raster.js';

/**
 * Where the cache keys of each group live. The service worker caches `/img/` by the full URL, so a changed picture needs a
 * new key in the URL that names it. Each pattern must match exactly once and capture the key.
 */
export const KEY_SOURCES = Object.freeze({
    home: [{ field: 'value', file: 'public/scripts/sillybunny-home/art-sources.js', pattern: /export const ART_VERSION = '(\d{8}[a-z])';/ }],
    splash: [
        { field: 'value', file: 'public/scripts/sillybunny-splash.js', pattern: /var ART_VERSION = '(\d{8}[a-z])';/ },
        // A new ART_VERSION changes the splash script, which index.html loads by a versioned URL.
        { field: 'script', file: 'public/index.html', pattern: /scripts\/sillybunny-splash\.js\?v=(\d{8}[a-z])/ },
    ],
});
const KEY_PATTERN = /^\d{8}[a-z]$/;

/**
 * A digest of every file the group's keys cache: a stamp that differs from the one in the manifest means a file changed
 * since its key last changed.
 * @param {any} manifest
 * @param {string} group
 */
export function stampOf(manifest, group) {
    const lines = Object.values(manifest.assets)
        .filter((asset) => asset.key === group)
        .flatMap(outputsOf)
        .map(({ path, sha256: digest }) => `${path}\t${digest}\n`)
        .sort();
    return sha256(lines.join(''));
}

/**
 * The next key after `current`: the next letter on the same day, or `a` on a later day. A key dated after `today` keeps
 * its day, so a key never goes back.
 * @param {string} current Such as `20261105a`.
 * @param {string} today Such as `20261114`.
 */
export function nextKey(current, today) {
    const day = current.slice(0, 8) > today ? current.slice(0, 8) : today;
    if (day !== current.slice(0, 8)) {
        return `${day}a`;
    }
    if (current[8] === 'z') {
        throw new Error(`${current} is the last key of its day; pass --key with a later one.`);
    }
    return `${day}${String.fromCharCode(current.charCodeAt(8) + 1)}`;
}

/**
 * @param {string} root
 * @returns {{ keys: Record<string, Record<string, string>>, problems: object[] }} The key of each field of each group, as the files hold it.
 */
export function readKeys(root) {
    const keys = {};
    const problems = [];
    for (const [group, sources] of Object.entries(KEY_SOURCES)) {
        keys[group] = {};
        for (const { field, file, pattern } of sources) {
            const matches = [...readFileSync(join(root, file), 'utf8').matchAll(new RegExp(pattern, 'g'))];
            if (matches.length !== 1) {
                problems.push({ code: 'key-source', path: file, message: `${file} holds the ${group} key ${matches.length} times; it must hold it once.` });
                continue;
            }
            keys[group][field] = matches[0][1];
        }
    }
    return { keys, problems };
}

/**
 * Checks that no key in the files is older than the one the manifest recorded, and that no file has changed since its key
 * did. A key ahead of the record passes: the splash script's key also moves when that script's code changes.
 * @param {string} root
 * @param {any} manifest
 */
export function keyProblems(root, manifest) {
    if (!manifest.keys) {
        return [{ code: 'key-missing', message: 'The manifest records no keys. Run bump --write.' }];
    }
    const { keys, problems } = readKeys(root);
    for (const group of KEY_GROUPS) {
        const recorded = manifest.keys[group];
        if (!recorded) {
            problems.push({ code: 'key-missing', message: `The manifest records no ${group} keys. Run bump --write.` });
            continue;
        }
        for (const [field, key] of Object.entries(keys[group])) {
            if (recorded[field] === undefined || key < recorded[field]) {
                problems.push({ code: 'key-mismatch', message: `The files hold the ${group} ${field} key ${key}, but the manifest records ${recorded[field]}. Change keys with bump --write, not by hand.` });
            }
        }
        if (recorded.stamp !== stampOf(manifest, group)) {
            problems.push({ code: 'key-stale', message: `A ${group} file changed since its key did. Run bump --write.` });
        }
    }
    return problems;
}

/**
 * The keys that change: every key of a group whose stamp is stale. With `key`, every changed key takes it.
 * @param {string} root
 * @param {any} manifest
 * @param {{ today: string, key?: string }} options `today` as YYYYMMDD.
 * @returns {{ bumps: { group: string, field: string, file: string, from: string, to: string }[], problems: object[] }}
 */
export function planBump(root, manifest, { today, key }) {
    const { keys, problems } = readKeys(root);
    if (problems.length > 0) {
        return { bumps: [], problems };
    }
    if (key !== undefined && !KEY_PATTERN.test(key)) {
        return { bumps: [], problems: [{ code: 'usage', message: `--key must look like 20261114a, got ${key}.` }] };
    }
    const bumps = [];
    for (const group of KEY_GROUPS) {
        if (manifest.keys?.[group]?.stamp === stampOf(manifest, group)) {
            continue;
        }
        for (const { field, file } of KEY_SOURCES[group]) {
            const from = keys[group][field];
            const to = key ?? nextKey(from, today);
            if (to <= from) {
                problems.push({ code: 'usage', message: `The ${group} ${field} key is ${from} already, so ${to} is not newer.` });
            }
            bumps.push({ group, field, file, from, to });
        }
    }
    return { bumps, problems };
}

/**
 * Writes the new keys into their files and records them, with fresh stamps, in the manifest. Each file is read, changed
 * and checked before the first one is written.
 * @param {string} root
 * @param {any} manifest Changed in place.
 * @param {ReturnType<typeof planBump>['bumps']} bumps
 */
export function applyBump(root, manifest, bumps) {
    const texts = new Map();
    for (const { group, field, file, to } of bumps) {
        const source = KEY_SOURCES[group].find((candidate) => candidate.field === field);
        const text = texts.get(file) ?? readFileSync(join(root, file), 'utf8');
        texts.set(file, text.replace(source.pattern, (match, key) => match.replace(key, to)));
    }
    for (const [file, text] of texts) {
        writeFileSync(join(root, file), text);
    }
    const keys = { ...manifest.keys };
    for (const group of new Set(bumps.map(({ group }) => group))) {
        const changed = Object.fromEntries(bumps.filter((bump) => bump.group === group).map(({ field, to }) => [field, to]));
        keys[group] = { ...keys[group], ...changed, stamp: stampOf(manifest, group) };
    }
    manifest.keys = keys;
}
