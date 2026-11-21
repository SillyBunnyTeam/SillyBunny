import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLogEntry, makeLogEntry, sha256 } from '../scripts/lib/log.mjs';
import { snapRaster } from '../scripts/lib/pixel-snap.mjs';
import { createRaster, writeRaster } from '../scripts/lib/raster.mjs';
import { composeGridScene } from '../scripts/lib/scene-compose.mjs';
import { parseLayout } from '../scripts/lib/scene-layout.mjs';
import { figure } from './figure.mjs';
import { setPixel } from './synthetic.mjs';
import { tempDir } from './temp-dir.mjs';

export const DARK = [20, 20, 40, 255];
const GRADE = { toward: '#7d8fd6', amount: 0.14, lightness: -0.03, keepSticker: true };

/** The fixture figure snapped on a 3.2 pixel grid with 2+2 rings: a 93x162 picture whose head top is found. */
export const snappedFigure = () => snapRaster(figure(), { cell: 3.2, offset: { x: 0, y: 0 }, rimWidth: 2, bandWidth: 2 }).raster;

/** The same picture with a block of dark pixels across the eyes, the way the blink frames differ from their base: the eyes and nothing else. */
export function eyesShut(base) {
    const shut = { ...base, data: Buffer.from(base.data) };
    for (let y = 46; y < 49; y++) {
        for (let x = 41; x < 53; x++) {
            setPixel(shut, x, y, DARK);
        }
    }
    return shut;
}

/** A small round star on a transparent picture, for a static layer. */
function star() {
    const raster = createRaster(12, 12);
    for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 12; x++) {
            if (Math.hypot(x - 5.5, y - 5.5) <= 5) {
                setPixel(raster, x, y, [250, 220, 90, 255]);
            }
        }
    }
    return raster;
}

/**
 * A package with an approved grid scene `mini` of three layers: a `star` (a backdrop), `alice` (a figure, graded, with blink frames) and `bob`
 * (a figure, with no blink frames). The stills are in approved/pixel/, the layout in layouts/, the scene composed from them is
 * approved/pixel/mini.png, and the log has the compose line that was approved as it, with the placements. The config files are the real ones.
 */
export async function breathWorkspace({ withSnapConfig = true } = {}) {
    const rootDir = tempDir('sb-breath-');
    for (const dir of ['approved/pixel', 'layouts', 'log']) {
        mkdirSync(join(rootDir, dir), { recursive: true });
    }
    const base = snappedFigure();
    const stills = { 'mini-star': star(), 'mini-alice': base, 'mini-alice--half': eyesShut(base), 'mini-alice--closed': eyesShut(eyesShut(base)), 'mini-bob': base };
    for (const [name, raster] of Object.entries(stills)) {
        await writeRaster(join(rootDir, 'approved', 'pixel', `${name}.png`), raster);
    }
    const layout = {
        canvas: { width: 480, height: 360 },
        grid: { cell: 2 },
        layers: [
            { id: 'star', image: 'raw/s5/masters/star.png', pixel: 'approved/pixel/mini-star.png', z: 0, at: 'centre', anchor: { x: 60, y: 60 }, height: 24 },
            { id: 'alice', image: 'raw/s5/masters/alice.png', pixel: 'approved/pixel/mini-alice.png', z: 1, at: 'bottom-centre', measure: 'figure', anchor: { x: 150, y: 340 }, height: 300, grade: GRADE },
            { id: 'bob', image: 'raw/s5/masters/bob.png', pixel: 'approved/pixel/mini-bob.png', z: 2, at: 'bottom-centre', measure: 'figure', anchor: { x: 330, y: 340 }, height: 300 },
        ],
    };
    writeFileSync(join(rootDir, 'layouts', 'mini.grid.json'), JSON.stringify(layout));
    const parsed = parseLayout(layout);
    const composed = composeGridScene(parsed, new Map([['star', stills['mini-star']], ['alice', base], ['bob', base]]));
    await writeRaster(join(rootDir, 'approved', 'pixel', 'mini.png'), composed.raster);
    const sceneBytes = readFileSync(join(rootDir, 'approved', 'pixel', 'mini.png'));
    appendLogEntry(join(rootDir, 'log', 'generations.jsonl'), {
        ...makeLogEntry({
            time: '2026-11-01T10:00:00.000Z',
            stage: 's5',
            provider: 'local',
            model: 'compose-scene',
            template: 'compose-scene',
            vars: {
                layout: 'layouts/mini.grid.json',
                inputs: layout.layers.map(({ id, pixel }) => `${id}=${pixel}`),
                placements: composed.placements.map(({ id, left, top, width, height, scale }) => ({ id, left, top, width, height, scale })),
                grid: composed.grid,
                grades: { alice: GRADE },
            },
            refHashes: [],
            size: `${composed.raster.width}x${composed.raster.height}`,
            outputs: [{ file: 'raw/s5/pixel-body/mini.png', sha256: sha256(sceneBytes), approved: true, approvedAs: 'pixel/mini.png' }],
            estimatedUsd: 0,
        }),
        approved: true,
    });
    writeFileSync(join(rootDir, 'breath-config.json'), JSON.stringify({ waist: 0.55, cycleSeconds: 3.5, breathsPerCycle: 2, stills: ['mini-alice'], scenes: ['mini'] }));
    if (withSnapConfig) {
        writeFileSync(join(rootDir, 'snap-config.json'), JSON.stringify({ bodyHeights: { tewi: 283, reisen: 340 }, lineupRatio: 0.8333, rings: { rim: 2, band: 2 } }));
    }
    return { rootDir, layout: parsed, composed, stills, logPath: join(rootDir, 'log', 'generations.jsonl') };
}
