#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { runBuildCards } from './lib/card-run.mjs';

const USAGE = [
    'Usage: build-card.mjs --card-dir <folder with the card files> --dry-run [--only reisen,tewi]',
    '       build-card.mjs --card-dir <folder> --preview [--only ...]                  writes the card and the avatar previews under out/cards/, logs nothing',
    '       build-card.mjs --card-dir <folder> --stage s5 [--only ...] [--overwrite]    writes default/content/default_Assistant<Name>.png, the previews, and logs',
].join('\n');
const say = (line) => process.stdout.write(`${line}\n`);
const boxText = (box) => `${box.width}x${box.height} at ${box.x},${box.y}`;

try {
    const { values } = parseArgs({
        options: {
            'card-dir': { type: 'string' },
            only: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            preview: { type: 'boolean', default: false },
            stage: { type: 'string' },
            overwrite: { type: 'boolean', default: false },
        },
    });
    if (!values['card-dir']) {
        throw new Error(USAGE);
    }
    const modes = [values['dry-run'] && 'dry-run', values.preview && 'preview', values.stage && 'build'].filter(Boolean);
    if (modes.length !== 1) {
        throw new Error(`Pass one of --dry-run, --preview and --stage.\n${USAGE}`);
    }
    const [mode] = modes;
    if (values.overwrite && mode !== 'build') {
        throw new Error('--overwrite replaces a card in default/content/, which only a build (--stage) writes.');
    }
    if (values.stage !== undefined && !/^s\d+$/.test(values.stage)) {
        throw new Error(`--stage must be a stage such as s5, got "${values.stage}".`);
    }
    const { built, previews, written } = await runBuildCards({
        rootDir: ROOT_DIR,
        repoRoot: resolve(ROOT_DIR, '..', '..'),
        cardDir: resolve(values['card-dir']),
        only: values.only?.split(',').map((id) => id.trim()).filter(Boolean),
        mode,
        stage: values.stage,
        overwrite: values.overwrite,
        now: () => new Date(),
    });
    say(mode === 'dry-run' ? 'DRY RUN, nothing written or logged' : mode === 'preview' ? 'PREVIEW, nothing logged' : 'BUILD');
    for (const one of built) {
        const { cut, box } = one.sprite;
        say(`${one.id}: ${one.output}, ${one.png.length} bytes${mode === 'build' ? '' : ' (not written to default/content/)'}`);
        say(`  art ${one.art.file} sha256 ${one.art.sha256.slice(0, 16)}; card ${one.cardFile.name} sha256 ${one.cardFile.sha256.slice(0, 16)}`);
        say(`  waist cut: visible down to row ${cut.visibleBottom}, ${cut.stickerRows} rows of sticker, last art row ${cut.lastArtRow}, kept down to row ${cut.lastKeptRow}; sprite ${boxText(box)} in the art`);
        say(`  placed ${one.placement.width}x${one.placement.height} (scale ${one.placement.scale.toFixed(4)}) at ${one.placement.left},${one.placement.top}, bottom edge flush; avatar crop (centre cover, as the app draws it) ${boxText(one.avatarBox)}`);
        say(`  card edits: ${one.edits.length === 0 ? 'none' : one.edits.map((edit) => `${edit.path} ${edit.change === 'set' ? `${JSON.stringify(edit.from)} -> ${JSON.stringify(edit.to)}` : `removed (${edit.from})`}`).join('; ')}`);
        say(`  text chunks ${one.chunks.join(', ')}; read back with the app's parser, ${one.fields} fields compared, all the same`);
    }
    for (const file of [...written, ...previews]) {
        say(file);
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
