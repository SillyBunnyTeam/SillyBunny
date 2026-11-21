import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeRaster } from '../scripts/lib/raster.mjs';
import { figure } from './figure.mjs';
import { setPixel } from './synthetic.mjs';
import { tempDir } from './temp-dir.mjs';

const SKIN = [250, 215, 190, 255];

const paint = (raster, box, colour) => {
    for (let y = box.y; y < box.y + box.height; y++) {
        for (let x = box.x; x < box.x + box.width; x++) {
            setPixel(raster, x, y, colour);
        }
    }
};

export const LEGS = { x: 90, y: 400, width: 120, height: 120 };

export const SPLASH_CONFIG = {
    bases: {
        reisen: { id: 'loop-a', file: 'raw/s5/splash/base-a.png', character: 'reisen', pose: 'idle', options: { cell: 3 } },
        tewi: { id: 'loop-b', file: 'raw/s5/splash/base-b.png', character: 'tewi', pose: 'raised', options: { cell: 3 } },
    },
    keep: { tewi: [{ name: 'legs', box: LEGS }] },
    frames: [
        { name: 'call', base: 'reisen', edit: 'raw/s5/splash/call.png', settings: { colourTolerance: 30 } },
        { name: 'mid', base: 'tewi', edit: 'raw/s5/splash/mid.png', keep: 'tewi', settings: { colourTolerance: 30 } },
    ],
    scene: { id: 'loop-both', left: 'reisen', right: 'tewi', gap: 4, margin: 3 },
    timelines: {
        reisen: { seconds: 2.4, keys: [{ at: 0, frame: 'idle' }, { at: 0.8, frame: 'call' }], effect: { frame: 'call', at: { x: 0.8, y: 0.2 } } },
        tewi: { seconds: 1.6, keys: [{ at: 0, frame: 'raised' }, { at: 0.5, frame: 'mid' }], effect: { frame: 'mid', at: { x: 0.8, y: 0.7 } } },
        both: { seconds: 2.4, reisen: [{ at: 0, frame: 'idle' }, { at: 0.8, frame: 'call' }], tewi: [{ at: 0, frame: 'raised' }, { at: 0.8, frame: 'mid' }] },
    },
};

/**
 * A package with two smooth masters (the sticker figure, the second one moved to the right), an edit of the first that opens a mouth in the face (a
 * patch the size of the face's middle), and an edit of the second that has a thinner sticker, a new arm, a faint dark cloud and a blob away from the figure.
 * The config files are written beside them, with the real rings (2+2); the log has no lines.
 */
export async function splashWorkspace({ config = SPLASH_CONFIG, withEdits = true } = {}) {
    const rootDir = tempDir('sb-splash-');
    mkdirSync(join(rootDir, 'raw', 's5', 'splash'), { recursive: true });
    const first = figure();
    const second = figure({ shiftX: 10 });
    await writeRaster(join(rootDir, 'raw', 's5', 'splash', 'base-a.png'), first);
    await writeRaster(join(rootDir, 'raw', 's5', 'splash', 'base-b.png'), second);
    if (withEdits) {
        const call = figure();
        paint(call, { x: 140, y: 150, width: 22, height: 22 }, [150, 30, 60, 255]);
        await writeRaster(join(rootDir, 'raw', 's5', 'splash', 'call.png'), call);
        const mid = figure({ shiftX: 10, sticker: 2 });
        paint(mid, { x: 195, y: 215, width: 80, height: 26 }, SKIN);
        paint(mid, { x: 20, y: 400, width: 40, height: 30 }, [20, 20, 30, 70]);
        paint(mid, { x: 250, y: 470, width: 30, height: 30 }, [20, 20, 30, 255]);
        await writeRaster(join(rootDir, 'raw', 's5', 'splash', 'mid.png'), mid);
    }
    writeFileSync(join(rootDir, 'snap-config.json'), JSON.stringify({ bodyHeights: { tewi: 283, reisen: 340 }, lineupRatio: 0.8333, rings: { rim: 2, band: 2 } }));
    writeFileSync(join(rootDir, 'splash-config.json'), JSON.stringify(config));
    return { rootDir, logPath: join(rootDir, 'log', 'generations.jsonl') };
}
