#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runBreath } from './lib/breath-run.mjs';
import { ROOT_DIR } from './lib/cli.mjs';

const USAGE = [
    'Usage: breath-frames.mjs --dry-run [--still <id>,...] [--scene hero-duo,...]      builds and checks in memory, writes nothing',
    '       breath-frames.mjs --preview [--still ...] [--scene ...]                    writes out/breath/ and out/gallery/breath.html, logs nothing',
    '       breath-frames.mjs --stage s5 [--still ...] [--scene ...]                   writes raw/s5/pixel-body/breath/ and logs each source picture',
    'With neither --still nor --scene, the pictures breath-config.json lists are made.',
].join('\n');
const say = (line) => process.stdout.write(`${line}\n`);
const list = (text) => text?.split(',').map((name) => name.trim()).filter(Boolean);

try {
    const { values } = parseArgs({
        options: {
            still: { type: 'string' },
            scene: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
            preview: { type: 'boolean', default: false },
            stage: { type: 'string' },
        },
    });
    const modes = [values['dry-run'] && 'dry-run', values.preview && 'preview', values.stage && 'build'].filter(Boolean);
    if (modes.length !== 1) {
        throw new Error(`Pass one of --dry-run, --preview and --stage.\n${USAGE}`);
    }
    const [mode] = modes;
    const { models, jobs, written, logged } = await runBreath({ rootDir: ROOT_DIR, stills: list(values.still), scenes: list(values.scene), mode, stage: values.stage, now: () => new Date() });
    say(mode === 'dry-run' ? 'DRY RUN, nothing written or logged' : mode === 'preview' ? 'PREVIEW, nothing logged' : 'RUN');
    for (const model of models) {
        say(`${model.id} (${model.kind}, ${model.width}x${model.height})${model.backdrop ? `, backdrop ${model.backdrop.file}` : ''}`);
        for (const layer of model.layers) {
            say(`  ${layer.id}: placed ${layer.width}x${layer.height} at ${layer.left},${layer.top}, waist row ${layer.waist} of the picture`);
        }
    }
    for (const { label, vars } of jobs.filter(({ vars: one }) => one.waist !== undefined)) {
        say(`${label}: ${vars.variants.join(', ')}; waist row ${vars.waist} of the still (figure rows ${vars.figureTop} to ${vars.figureBottom}), outline defects mended ${vars.outlineFixed}, ring pixels recoloured ${Object.entries(vars.ringsChanged).map(([variant, count]) => `${variant} ${count}`).join(', ')}, orphans ${vars.orphans} (source ${vars.orphansOfSource})`);
    }
    say(logged > 0 ? `${written.length} files written, ${logged} log lines added` : `${written.length} files written, nothing logged`);
    for (const file of written) {
        say(file);
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
