import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRaster, crop, opaqueBox, writeRaster } from '../scripts/lib/raster.mjs';
import { changedPixels } from '../scripts/lib/snap-frame.mjs';
import { gradeSnappedStill } from '../scripts/lib/scene-compose.mjs';
import { buildBreath } from '../scripts/lib/breath-pose.mjs';
import { composeBackdrop, drawScene, exportLayer, findApprovedSceneEntry, loadScene } from '../scripts/lib/breath-scene.mjs';
import { breathWorkspace, snappedFigure } from '../test-support/breath-workspace.mjs';
import { getPixel } from '../test-support/synthetic.mjs';

const RINGS = { rimWidth: 2, bandWidth: 2 };
const changedRowsOf = (one, two) => [...new Set(changedPixels(one, two).map((at) => Math.floor(at / one.width)))].sort((a, b) => a - b);
const build = (variants) => buildBreath({ variants, waistShare: 0.55, rings: RINGS });

async function loaded() {
    const space = await breathWorkspace();
    const scene = await loadScene({ rootDir: space.rootDir, scene: 'mini' });
    return { ...space, scene };
}

test('the approved scene is read from the log: its layout, the placements it logged, the figures that breathe and the layers that are a backdrop', async () => {
    const { scene, composed } = await loaded();
    assert.deepEqual(scene.figures.map(({ layer }) => layer.id), ['alice', 'bob']);
    assert.deepEqual(scene.statics.map(({ layer }) => layer.id), ['star']);
    assert.deepEqual(Object.keys(scene.figures[0].pictures), ['base', 'half', 'closed']);
    assert.deepEqual(Object.keys(scene.figures[1].pictures), ['base'], 'a figure with no blink frames has only its base');
    for (const placement of composed.placements) {
        assert.equal(scene.placements.get(placement.id).left, placement.left);
    }
    assert.deepEqual(scene.grid, { cell: 2, width: 240, height: 180 });
});

test('a scene that was never approved, and stills that no longer compose the approved scene, are refused', async () => {
    const space = await breathWorkspace();
    await assert.rejects(loadScene({ rootDir: space.rootDir, scene: 'other' }), /no approved grid scene called other\.png/);
    assert.throws(() => findApprovedSceneEntry(space.rootDir, 'mini-alice'), /no approved grid scene/);
    await writeRaster(join(space.rootDir, 'approved', 'pixel', 'mini-bob.png'), createRaster(93, 162));
    await assert.rejects(loadScene({ rootDir: space.rootDir, scene: 'mini' }), /The picture for layer "bob" is empty/);
    const changed = await breathWorkspace();
    const still = snappedFigure();
    still.data.set([255, 0, 0, 255], (100 * still.width + 47) * 4);
    await writeRaster(join(changed.rootDir, 'approved', 'pixel', 'mini-alice.png'), still);
    await assert.rejects(loadScene({ rootDir: changed.rootDir, scene: 'mini' }), /do not compose approved\/pixel\/mini\.png pixel for pixel/);
});

test('the backdrop is the scene without its figures, and a scene with no static layer has none', async () => {
    const { scene } = await loaded();
    const backdrop = composeBackdrop(scene);
    assert.deepEqual([backdrop.width, backdrop.height], [240, 180]);
    const starBox = opaqueBox(backdrop, 1);
    const placement = scene.placements.get('star');
    assert.deepEqual([starBox.x, starBox.y, starBox.width, starBox.height], [placement.left, placement.top, placement.width, placement.height]);
    for (const id of ['alice', 'bob']) {
        const at = scene.placements.get(id);
        assert.equal(getPixel(backdrop, at.left + Math.floor(at.width / 2), at.top + at.height - 3)[3], 0, `${id} is not in it`);
    }
    assert.equal(composeBackdrop({ ...scene, statics: [] }), null);
});

/** The frame of an exported layer in the pixels of its still, from where the layer's placement moved. */
const frameInStill = (exported, placement, box) => ({ x: box.x + exported.left - placement.left, y: box.y + exported.top - placement.top, width: exported.width, height: exported.height });

test('a layer image set has one frame for both poses and every variant, the frame of the figure itself, so the centre pose lands where the scene had her', async () => {
    const { scene } = await loaded();
    const alice = scene.figures[0];
    const built = build(Object.fromEntries(Object.entries(alice.pictures).map(([variant, { raster }]) => [variant, raster])));
    const placement = scene.placements.get('alice');
    const exported = exportLayer({ built, placement, grade: alice.layer.grade });
    assert.deepEqual([...exported.images.keys()], ['c', 'b']);
    for (const byVariant of exported.images.values()) {
        assert.deepEqual(Object.keys(byVariant), ['base', 'half', 'closed']);
        for (const picture of Object.values(byVariant)) {
            assert.deepEqual([picture.width, picture.height], [exported.width, exported.height]);
        }
    }
    assert.deepEqual([exported.left, exported.top, exported.width, exported.height], [placement.left, placement.top, placement.width, placement.height], 'the breath moves rows down inside the figure\'s box, so the box is the frame');
    const box = opaqueBox(alice.pictures.base.raster, 1);
    const frame = frameInStill(exported, placement, box);
    assert.ok(exported.images.get('c').base.data.equals(crop(gradeSnappedStill(alice.pictures.base.raster, alice.layer.grade), frame).data), 'the centre pose is the graded still, cut to the frame');
    assert.equal(exported.waist, built.waist - frame.y, 'the waist row is in the rows of the frame');
});

test('the grade the layer has in the scene is applied to every pose and variant after the breath shift, and a layer with none is not graded', async () => {
    const { scene } = await loaded();
    const [alice, bob] = scene.figures;
    const builtAlice = build(Object.fromEntries(Object.entries(alice.pictures).map(([variant, { raster }]) => [variant, raster])));
    const placement = scene.placements.get('alice');
    const graded = exportLayer({ built: builtAlice, placement, grade: alice.layer.grade });
    const plain = exportLayer({ built: builtAlice, placement, grade: undefined });
    assert.ok(!graded.images.get('b').base.data.equals(plain.images.get('b').base.data), 'grading changes the colours');
    const frame = frameInStill(graded, placement, opaqueBox(alice.pictures.base.raster, 1));
    for (const [pose, variant] of [['b', 'base'], ['b', 'half'], ['b', 'closed'], ['c', 'half']]) {
        const shifted = builtAlice.poses.find(({ name }) => name === pose).variants[variant].raster;
        assert.ok(graded.images.get(pose)[variant].data.equals(crop(gradeSnappedStill(shifted, alice.layer.grade), frame).data), `${pose} ${variant} is the pose, then the grade`);
    }
    const bobBuilt = build({ base: bob.pictures.base.raster });
    const bobPlacement = scene.placements.get('bob');
    const ungraded = exportLayer({ built: bobBuilt, placement: bobPlacement, grade: bob.layer.grade });
    const bobFrame = frameInStill(ungraded, bobPlacement, opaqueBox(bob.pictures.base.raster, 1));
    assert.ok(ungraded.images.get('b').base.data.equals(crop(bobBuilt.poses[1].variants.base.raster, bobFrame).data), 'a layer with no grade is the pose as it is');
});

test('the layer images of the centre pose, drawn at their placements over the backdrop in z order, are the approved scene pixel for pixel', async () => {
    const { scene } = await loaded();
    const layers = scene.figures.map((figure) => {
        const built = build(Object.fromEntries(Object.entries(figure.pictures).map(([variant, { raster }]) => [variant, raster])));
        const exported = exportLayer({ built, placement: scene.placements.get(figure.layer.id), grade: figure.layer.grade });
        return { z: figure.layer.z, order: figure.index, left: exported.left, top: exported.top, images: exported.images };
    });
    const drawn = drawScene({ grid: scene.grid, backdrop: composeBackdrop(scene), layers, pose: 'c' });
    assert.ok(drawn.data.equals(scene.scene.raster.data));
    const breathing = drawScene({ grid: scene.grid, backdrop: composeBackdrop(scene), layers, pose: 'b' });
    assert.ok(!breathing.data.equals(scene.scene.raster.data), 'the breath pose is a different picture');
    const feetRow = scene.placements.get('alice').top + scene.placements.get('alice').height;
    assert.ok(changedRowsOf(breathing, scene.scene.raster).at(-1) < feetRow - 40, 'and the feet and the lower body are as they were');
    assert.ok(layers.every((layer) => layer.left >= 0 && layer.top >= 0));
});

test('a scene with no figure, or with a backdrop layer in front of a figure, cannot breathe', async () => {
    const none = await breathWorkspace();
    const layoutPath = join(none.rootDir, 'layouts', 'mini.grid.json');
    const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
    writeFileSync(layoutPath, JSON.stringify({ ...layout, layers: layout.layers.map((layer) => ({ ...layer, measure: 'box' })) }));
    await assert.rejects(loadScene({ rootDir: none.rootDir, scene: 'mini' }), /no layer measured as a "figure"/);
    const front = await breathWorkspace();
    const frontPath = join(front.rootDir, 'layouts', 'mini.grid.json');
    writeFileSync(frontPath, JSON.stringify({ ...layout, layers: layout.layers.map((layer) => (layer.id === 'star' ? { ...layer, z: 5 } : layer)) }));
    await assert.rejects(loadScene({ rootDir: front.rootDir, scene: 'mini' }), /static layer of mini is drawn over or with a figure/);
});
