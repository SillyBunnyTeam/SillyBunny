#!/usr/bin/env node
/**
 * Builds the emoji font: `public/webfonts/SBEmoji/<file>.woff2`, its CC BY 4.0 licence text, the list of the emoji that it
 * draws (`font-coverage.txt`), its `unicode-range` (`font-unicode-range.txt`), the `@font-face` block of
 * `public/css/sillybunny-conversation.css` and the `font` section of `manifest.json`. Run it again, then run
 * `build-emoji-data.js`, when `sources.json` names a new Twemoji or nanoemoji.
 *
 *   node scripts/emoji/build-emoji-font.js              build everything
 *   node scripts/emoji/build-emoji-font.js --css-only   write the `@font-face` block again from the committed range and key
 *
 * Needs `tar`, and `uv` or `python3.12`, on macOS or Linux. About 6 minutes. It makes a venv in a temporary directory and
 * installs `requirements.txt` with `--require-hashes`; it installs nothing into the repository or the system. Every input is
 * checked against `sources.json` before it is used (`sources.js`).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { placeFontFaceBlock, renderFontFaceBlock } from './font-face-block.js';
import { fetchEmojibase, fetchTwemoji, makeWorkDirectory, repositoryRoot, sha256, sources, writeManifestSection } from './sources.js';

const MAX_EMOJI_VERSION = 17;
const fontDirectory = path.join(repositoryRoot, sources.font.directory);
const cssPath = path.join(repositoryRoot, 'public/css/sillybunny-conversation.css');

function has(command, ...arguments_) {
    return spawnSync(command, arguments_, { stdio: 'ignore' }).status === 0;
}

function makeVirtualEnvironment(directory) {
    const venv = path.join(directory, 'venv');
    const requirements = path.join(repositoryRoot, sources.nanoemoji.requirements);
    if (has('uv', '--version')) {
        execFileSync('uv', ['venv', '--python', sources.nanoemoji.python, venv], { stdio: 'inherit' });
        execFileSync('uv', ['pip', 'install', '--python', path.join(venv, 'bin', 'python'), '--require-hashes', '-r', requirements], { stdio: 'inherit' });
    } else if (has(`python${sources.nanoemoji.python}`, '--version')) {
        execFileSync(`python${sources.nanoemoji.python}`, ['-m', 'venv', venv], { stdio: 'inherit' });
        execFileSync(path.join(venv, 'bin', 'python'), ['-m', 'pip', 'install', '--require-hashes', '-r', requirements], { stdio: 'inherit' });
    } else {
        throw new Error(`Neither uv nor python${sources.nanoemoji.python} is installed.`);
    }
    return path.join(venv, 'bin', 'python');
}

function writeFontFaceBlock(range) {
    const block = renderFontFaceBlock({ family: sources.font.family, file: sources.font.file, cacheKey: sources.font.cacheKey, range });
    writeFileSync(cssPath, placeFontFaceBlock(readFileSync(cssPath, 'utf8'), block));
}

if (process.argv.includes('--css-only')) {
    writeFontFaceBlock(readFileSync(path.join(repositoryRoot, 'scripts/emoji/font-unicode-range.txt'), 'utf8'));
    console.log('Wrote the @font-face block of the conversation stylesheet.');
    process.exit(0);
}

const work = makeWorkDirectory('font');
try {
    console.log('Fetching and checking the Twemoji files and the emojibase data...');
    const { svgDirectory, license } = await fetchTwemoji(path.join(work, 'twemoji'));
    const emojibase = await fetchEmojibase(path.join(work, 'emojibase'));

    console.log('Making the build environment...');
    const python = makeVirtualEnvironment(work);

    console.log('Building the font (about 6 minutes)...');
    const woff2 = path.join(work, 'out.woff2');
    const coverage = path.join(work, 'coverage.txt');
    const range = path.join(work, 'range.txt');
    const summary = path.join(work, 'summary.json');
    execFileSync(python, [
        path.join(repositoryRoot, 'scripts/emoji/build_emoji_font.py'),
        '--svg', svgDirectory,
        '--emojibase-en', path.join(emojibase, 'en', 'data.json'),
        '--work', path.join(work, 'build'),
        '--woff2', woff2,
        '--coverage', coverage,
        '--range', range,
        '--summary', summary,
        '--max-version', String(MAX_EMOJI_VERSION),
    ], { stdio: 'inherit' });

    mkdirSync(fontDirectory, { recursive: true });
    copyFileSync(woff2, path.join(fontDirectory, sources.font.file));
    writeFileSync(path.join(fontDirectory, 'LICENSE-GRAPHICS'), license);
    copyFileSync(coverage, path.join(repositoryRoot, 'scripts/emoji/font-coverage.txt'));
    copyFileSync(range, path.join(repositoryRoot, 'scripts/emoji/font-unicode-range.txt'));

    writeFontFaceBlock(readFileSync(range, 'utf8'));

    const built = JSON.parse(readFileSync(summary, 'utf8'));
    const fontBytes = readFileSync(woff2);
    writeManifestSection('font', {
        file: sources.font.file,
        bytes: fontBytes.length,
        sha256: sha256(fontBytes),
        glyphs: built.glyphs,
        cmapEntries: built.cmapEntries,
        coverage: { count: built.drawn, sha256: sha256(readFileSync(coverage)), notDrawn: built.notDrawn, notDrawnVersions: built.notDrawnVersions },
        squaredSvgs: built.squaredSvgs,
        renamedSvgs: built.renamedSvgs,
        twemoji: { commit: sources.twemoji.commit, svgTreeSha256: sources.twemoji.svgTreeSha256 },
        nanoemoji: sources.nanoemoji.version,
        tools: built.tools,
    });
    console.log(`Done: ${fontBytes.length} bytes, ${built.drawn} emoji drawn, ${built.notDrawn} not drawn (Emoji ${built.notDrawnVersions.join(', ')}). Run build-emoji-data.js next.`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
