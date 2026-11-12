import { describe, expect, test } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webfontsRoot = fileURLToPath(new URL('../../public/webfonts/', import.meta.url));
const WOFF2_SIGNATURE = 'wOF2';

function listFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    });
}

function relativeToWebfonts(filePath) {
    return path.relative(webfontsRoot, filePath).split(path.sep).join('/');
}

function readFontUrls(stylesheetPath) {
    const css = readFileSync(stylesheetPath, 'utf8');
    return [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map(match => match[2]);
}

const allFiles = listFiles(webfontsRoot);
const woff2Files = allFiles.filter(file => file.endsWith('.woff2'));
const stylesheets = allFiles.filter(file => file.endsWith('stylesheet.css'));
const adwaitaFamilies = readdirSync(webfontsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('Adwaita'))
    .map(entry => entry.name);

describe('bundled webfonts', () => {
    test('finds the font files this suite guards', () => {
        expect(woff2Files.length).toBeGreaterThan(0);
        expect(stylesheets.length).toBeGreaterThan(0);
        expect(adwaitaFamilies.length).toBeGreaterThan(0);
    });

    // A raw TrueType file (first bytes 00 01 00 00) saved as .woff2 loads without any HTTP
    // error. The browser only discards it while decoding, then falls back to the next font.
    test.each(woff2Files.map(relativeToWebfonts))('%s is a real WOFF2 file', relativePath => {
        const signature = readFileSync(path.join(webfontsRoot, relativePath)).subarray(0, 4).toString('latin1');
        expect(signature).toBe(WOFF2_SIGNATURE);
    });

    test.each(stylesheets.map(relativeToWebfonts))('%s only references existing files', relativePath => {
        const stylesheetPath = path.join(webfontsRoot, relativePath);
        const missing = readFontUrls(stylesheetPath)
            .map(url => url.split(/[?#]/)[0])
            .filter(url => !existsSync(path.resolve(path.dirname(stylesheetPath), url)));
        expect(missing).toEqual([]);
    });

    // The service worker caches /webfonts/ by full URL, so a rebuilt font under an unchanged URL
    // is served stale. The Noto stylesheets are unmodified upstream files without a key; the
    // Adwaita sheets are SillyBunny's, so their bytes can change and the key must change with them.
    test.each(adwaitaFamilies)('%s font URLs carry a ?v= cache key', family => {
        const urls = readFontUrls(path.join(webfontsRoot, family, 'stylesheet.css'));
        expect(urls.length).toBeGreaterThan(0);
        expect(urls.filter(url => !/\?v=[\w.-]+$/.test(url))).toEqual([]);
    });
});
