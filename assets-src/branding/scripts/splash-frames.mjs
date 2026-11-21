#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ROOT_DIR } from './lib/cli.mjs';
import { runSplash } from './lib/splash-run.mjs';

const USAGE = [
    'Usage: splash-frames.mjs --dry-run                 builds and checks in memory, writes nothing',
    '       splash-frames.mjs --preview                 writes out/splash/ and out/gallery/splash-anim.html, logs nothing',
    '       splash-frames.mjs --stage s5                writes raw/s5/splash-anim/ and logs each base snap, composition, frame snap and layer',
    'The bases, edits, masks and timelines are in splash-config.json.',
].join('\n');
const say = (line) => process.stdout.write(`${line}\n`);
const boxText = (box) => (box ? `${box.width}x${box.height} at ${box.x},${box.y}` : 'none');

try {
    const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, preview: { type: 'boolean', default: false }, stage: { type: 'string' } } });
    const modes = [values['dry-run'] && 'dry-run', values.preview && 'preview', values.stage && 'build'].filter(Boolean);
    if (modes.length !== 1) {
        throw new Error(`Pass one of --dry-run, --preview and --stage.\n${USAGE}`);
    }
    const [mode] = modes;
    const { built, frames, scene, warnings, written, logged } = await runSplash({ rootDir: ROOT_DIR, mode, stage: values.stage, now: () => new Date() });
    say(mode === 'dry-run' ? 'DRY RUN, nothing written or logged' : mode === 'preview' ? 'PREVIEW, nothing logged' : 'RUN');
    for (const { prepared } of Object.values(built)) {
        const { report } = prepared;
        say(`${prepared.id}: ${report.size.width}x${report.size.height} art px, cell ${report.cell.toFixed(3)} (${report.cellSource}), head to feet ${report.body.height} (asked ${report.targetBodyHeight}), rings ${report.rings?.measured.rimWidth}+${report.rings?.measured.bandWidth}`);
    }
    for (const frame of frames) {
        const { check, composed } = frame;
        say(`${frame.id}: changed ${check.changed} art px in ${boxText(check.box)} (master ${boxText(check.masterBox)}); the mask is ${frame.maskPixels} master px in ${boxText(frame.maskBox)}`);
        say(`  sticker grown by ${composed.sticker.radius} px; dropped from the edit ${composed.dropped.edit.pixels} px in ${composed.dropped.edit.pieces} pieces; kept from the base: ${check.keep.map((part) => `${part.name} ${part.changed} of ${part.pixels} art px changed`).join(', ') || 'nothing named'}`);
    }
    say(`scene ${scene.width}x${scene.height} art px, layers ${scene.layers.map((layer) => `${layer.id} ${layer.width}x${layer.height} at ${layer.left},${layer.top} z${layer.z}`).join('; ')}`);
    for (const warning of warnings) {
        say(`WARNING: ${warning}`);
    }
    say(logged > 0 ? `${written.length} files written, ${logged} log lines added` : `${written.length} files written, nothing logged`);
    for (const file of written) {
        say(file);
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
