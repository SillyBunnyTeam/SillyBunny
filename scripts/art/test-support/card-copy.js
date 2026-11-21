import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from '../lib/codec.js';
import { MASTER_ROOT, readManifest } from '../lib/manifest.js';
import { sha256 } from '../lib/raster.js';
import { sampleRecord } from './manifests.js';
import { REPO_ROOT, paint } from './pictures.js';
import { copyOfArt, writeFixtureManifest } from './repos.js';

export const REISEN_CARD = 'default/content/default_AssistantReisen.png';
/** The files of default/content that the managed manifest reads beside the cards and the expression packs. */
const MANAGED_FILES = Object.freeze(['sillybunny-managed.json', 'SillyBunny Lexicon.json']);

/**
 * A waist-up sprite on a transparent ground, 8x12: a head over a body that the bottom edge cuts, as at the waist.
 * @param {number[]} [body] The colour of the body.
 */
export const cardSprite = (body = [90, 60, 140, 255]) => paint(8, 12, (x, y) => {
    if (y >= 2 && y < 5 && x >= 3 && x < 6) {
        return [250, 220, 200, 255];
    }
    return y >= 5 && x >= 1 && x < 7 ? body : [0, 0, 0, 0];
});

/**
 * A copy of the checkout's art with its pinned files and the managed content of default/content, in which card-reisen is a
 * card entry derived from `cardSprite()` at scale 4, with its text read from the card file it ships. Nothing is derived
 * yet, so the card file is still the shipped one.
 * @param {import('node:test').TestContext} t
 */
export async function copyWithDerivedCard(t) {
    const root = copyOfArt(t, { pinned: true });
    for (const file of MANAGED_FILES) {
        cpSync(join(REPO_ROOT, 'default/content', file), join(root, 'default/content', file));
    }
    const masterBytes = await encode(cardSprite(), 'png');
    writeFileSync(join(root, MASTER_ROOT, 'reisen/card-reisen.png'), masterBytes);
    writeFileSync(join(root, MASTER_ROOT, 'reisen/card-reisen.provenance.json'), `${JSON.stringify({ ...sampleRecord(), file: 'card-reisen.png', sha256: sha256(masterBytes) }, null, 4)}\n`);
    const { manifest } = readManifest(root);
    manifest.assets['card-reisen'] = {
        type: 'card',
        key: null,
        master: 'reisen/card-reisen.png',
        crop: [-1, -2, 8, 14],
        grid: [8, 14],
        gradient: { top: '#f5e9ff', bottom: '#d9c2f0' },
        text: REISEN_CARD,
        world: 'SillyBunny Lexicon',
        outputs: [{ path: REISEN_CARD, encoding: 'png-card', scale: 4, sha256: manifest.assets['card-reisen'].outputs[0].sha256 }],
    };
    writeFixtureManifest(root, manifest);
    return root;
}
