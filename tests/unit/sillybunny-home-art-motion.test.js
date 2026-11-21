/* eslint-disable playwright/no-standalone-expect -- Jest contracts for the idle motion of the art. */
import { describe, expect, test } from '@jest/globals';
import {
    BLINK_CLEARANCE_MS,
    BLINK_STAGGER_MS,
    BREATH_PHASE_STEP,
    breathPoseAt,
    canBlink,
    createBlinkState,
    DEFAULT_BLINK,
    FIRST_BLINK_MS,
    FIRST_BLINK_SPREAD_MS,
    msUntilBreathChange,
    parseBreathScene,
    pictureOf,
    planScene,
    stepBlinks,
} from '../../public/scripts/sillybunny-home/art-motion.js';

/** What `breath-frames.mjs` writes for a scene of two figures, with the keys it writes. */
function manifestOf(changes = {}) {
    return {
        scene: 'hero-duo',
        grid: { width: 332, height: 366 },
        rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
        poses: ['c', 'b'],
        backdrop: 'hero-duo--backdrop.webp',
        layers: [
            {
                id: 'tewi',
                z: 2,
                source: 'tewi.png',
                left: 190,
                top: 120,
                width: 120,
                height: 240,
                waist: 130,
                images: {
                    c: { base: 'hero-duo--tewi--c.webp', half: 'hero-duo--tewi--c--half.webp', closed: 'hero-duo--tewi--c--closed.webp' },
                    b: { base: 'hero-duo--tewi--b.webp', half: 'hero-duo--tewi--b--half.webp', closed: 'hero-duo--tewi--b--closed.webp' },
                },
            },
            {
                id: 'reisen',
                z: 1,
                source: 'reisen.png',
                left: 10,
                top: 4,
                width: 150,
                height: 362,
                waist: 200,
                images: {
                    c: { base: 'hero-duo--reisen--c.webp' },
                    b: { base: 'hero-duo--reisen--b.webp' },
                },
            },
        ],
        ...changes,
    };
}

describe('parseBreathScene', () => {
    test('reads a scene as breath-frames writes it', () => {
        const scene = parseBreathScene(manifestOf());

        expect(scene).toMatchObject({ scene: 'hero-duo', width: 332, height: 366, backdrop: 'hero-duo--backdrop.webp' });
        // A cycle of 3.5 seconds with two breaths.
        expect(scene.breathMs).toBe(1750);
        // Lowest z first, so the order is the drawing order.
        expect(scene.layers.map(layer => layer.id)).toEqual(['reisen', 'tewi']);
        expect(scene.layers[1].images.c.closed).toBe('hero-duo--tewi--c--closed.webp');
        expect(scene.blink).toBe(DEFAULT_BLINK);
    });

    test('a scene with no backdrop has none', () => {
        expect(parseBreathScene(manifestOf({ backdrop: null })).backdrop).toBeNull();
    });

    test('a scene whose blinks are null or missing takes the defaults', () => {
        expect(parseBreathScene(manifestOf({ blinks: null })).blink).toBe(DEFAULT_BLINK);
        expect(parseBreathScene(manifestOf({ blinks: undefined })).blink).toBe(DEFAULT_BLINK);
    });

    test('reads the blinks of the scene when it has them', () => {
        const blinks = { steps: [{ variant: 'closed', ms: 90 }], gapMs: [2000, 3000] };

        expect(parseBreathScene(manifestOf({ blinks })).blink).toEqual(blinks);
    });

    test.each([
        ['no layers', { layers: [] }, /at least one layer/],
        ['no rhythm', { rhythm: undefined }, /rhythm/],
        ['a rhythm of no breaths', { rhythm: { cycleSeconds: 3.5, breathsPerCycle: 0 } }, /breathsPerCycle/],
        ['a grid with no width', { grid: { height: 366 } }, /grid width/],
        ['a backdrop in a folder', { backdrop: '../hero-duo.webp' }, /backdrop/],
        ['a blink with no steps', { blinks: { steps: [], gapMs: [1, 2] } }, /at least one step/],
        ['a blink wait the wrong way round', { blinks: { steps: [{ variant: 'half', ms: 70 }], gapMs: [3000, 2000] } }, /below the shortest/],
        ['a blink step of an unknown kind', { blinks: { steps: [{ variant: 'wink', ms: 70 }], gapMs: [1, 2] } }, /unknown kind/],
        ['a blink step that shows the base picture', { blinks: { steps: [{ variant: 'base', ms: 70 }], gapMs: [1, 2] } }, /unknown kind/],
    ])('refuses %s', (_name, changes, message) => {
        expect(() => parseBreathScene(manifestOf(changes))).toThrow(message);
    });

    test.each([
        ['a layer with no breath pose', layers => delete layers[0].images.b, /no pictures for the pose "b"/],
        ['a picture of an unknown kind', layers => { layers[0].images.c.wink = 'x.webp'; }, /unknown kind "wink"/],
        ['a picture with a folder', layers => { layers[0].images.c.base = 'img/x.webp'; }, /no folder/],
        ['a picture with a way up', layers => { layers[0].images.c.base = '../x.webp'; }, /no folder/],
        ['a picture that is only a way up', layers => { layers[0].images.c.base = '..'; }, /no folder/],
        ['a picture whose name starts with a dot', layers => { layers[0].images.c.base = '.x.webp'; }, /not starting with a dot/],
        ['a picture with a query', layers => { layers[0].images.c.base = 'x.webp?v=1'; }, /must be a file name/],
        ['a picture with a fragment', layers => { layers[0].images.c.base = 'x.webp#top'; }, /must be a file name/],
        ['a picture with an escaped slash', layers => { layers[0].images.c.base = 'x%2fy.webp'; }, /must be a file name/],
        ['a picture with a space', layers => { layers[0].images.c.base = 'x y.webp'; }, /must be a file name/],
        ['a layer with a fraction for a size', layers => { layers[0].width = 120.5; }, /width must be a whole number/],
        ['a layer with no base picture', layers => delete layers[0].images.c.base, /base must be a file name/],
    ])('refuses %s', (_name, change, message) => {
        const manifest = manifestOf();
        change(manifest.layers);

        expect(() => parseBreathScene(manifest)).toThrow(message);
    });

    test('accepts the names that the exporter writes', () => {
        const manifest = manifestOf();
        manifest.layers[0].images.c.base = 'hero-duo--reisen--breath-c-half@native.webp';

        expect(() => parseBreathScene(manifest)).not.toThrow();
    });

    test('refuses what is not an object', () => {
        expect(() => parseBreathScene(null)).toThrow(/must be an object/);
    });
});

describe('the defaults of the motion contract', () => {
    // These are the numbers that the exporters write into a scene and that a scene with no `blinks` falls back on, so a change to
    // one of them is a change of the contract and has to be made on purpose.
    test('a blink is half, closed and half for 70, 110 and 70 ms, every 3.6 to 5.4 seconds', () => {
        expect(DEFAULT_BLINK.steps).toEqual([{ variant: 'half', ms: 70 }, { variant: 'closed', ms: 110 }, { variant: 'half', ms: 70 }]);
        expect(DEFAULT_BLINK.gapMs).toEqual([3600, 5400]);
    });

    test('the figures breathe 1.7 radians apart and blink for the first time 1.7 seconds apart', () => {
        expect(BREATH_PHASE_STEP * 2 * Math.PI).toBeCloseTo(1.7, 10);
        expect([FIRST_BLINK_MS, FIRST_BLINK_SPREAD_MS, BLINK_STAGGER_MS, BLINK_CLEARANCE_MS]).toEqual([1000, 1000, 1700, 400]);
    });
});

describe('the breath', () => {
    const BREATH = 1750;

    test('is in the breath pose for the first half of a breath and neutral for the other half', () => {
        expect(breathPoseAt(0, BREATH)).toBe('b');
        expect(breathPoseAt(874, BREATH)).toBe('b');
        expect(breathPoseAt(875, BREATH)).toBe('c');
        expect(breathPoseAt(1749, BREATH)).toBe('c');
        expect(breathPoseAt(1750, BREATH)).toBe('b');
        expect(breathPoseAt(5 * BREATH + 900, BREATH)).toBe('c');
    });

    test('a figure that is a little behind starts the same and changes sooner', () => {
        const phase = BREATH_PHASE_STEP;

        expect(breathPoseAt(0, BREATH, phase)).toBe('b');
        // The phase puts it 473.5 ms into the breath already, so the half is reached 401.5 ms in.
        expect(breathPoseAt(401, BREATH, phase)).toBe('b');
        expect(breathPoseAt(402, BREATH, phase)).toBe('c');
    });

    test('follows the clock of the contract: the breath count is time over the cycle times breaths, plus 1.7 radians per figure', () => {
        const cycleMs = 3500;
        for (const index of [0, 1, 2]) {
            for (const elapsed of [0, 500, 1200, 2600, 7777]) {
                const count = (elapsed / cycleMs) * 2 + (1.7 * index) / (2 * Math.PI);

                expect(breathPoseAt(elapsed, 1750, index * BREATH_PHASE_STEP)).toBe(count - Math.floor(count) < 0.5 ? 'b' : 'c');
            }
        }
    });

    test('waits until the next change, and never for less than a millisecond', () => {
        expect(msUntilBreathChange(0, BREATH)).toBe(875);
        expect(msUntilBreathChange(874, BREATH)).toBe(1);
        expect(msUntilBreathChange(875, BREATH)).toBe(875);
        expect(msUntilBreathChange(1750, BREATH)).toBe(875);
        expect(msUntilBreathChange(401, BREATH, BREATH_PHASE_STEP)).toBe(1);
    });

    // The wait is rounded up to a whole millisecond, and a boundary that lands between two floats may be a millisecond early, so
    // the pose is checked to hold until two milliseconds before the wait ends.
    test.each([0, 1, 300.5, 874.9, 875, 1000, 1749.99, 9000.3])('from %s ms the pose differs once the wait has passed, and holds until just before', (elapsed) => {
        for (const phase of [0, BREATH_PHASE_STEP, 2 * BREATH_PHASE_STEP]) {
            const wait = msUntilBreathChange(elapsed, BREATH, phase);

            expect(breathPoseAt(elapsed + wait, BREATH, phase)).not.toBe(breathPoseAt(elapsed, BREATH, phase));
            expect(breathPoseAt(elapsed + wait - 2, BREATH, phase)).toBe(breathPoseAt(elapsed, BREATH, phase));
        }
    });
});

describe('the blinks of a scene', () => {
    const noRandom = () => 0;
    /** Two figures that can blink and one that cannot, so the staggering has someone to wait for. */
    const twoFigures = () => {
        const manifest = manifestOf();
        const [tewi] = manifest.layers;
        manifest.layers.push({ ...tewi, id: 'reisen-too', z: 3, images: structuredClone(tewi.images) });
        return parseBreathScene(manifest);
    };
    /** The layers that can blink are the second and the third, in drawing order; the first has no blink pictures. */
    const state = (dueMs, extra = {}) => ({ layers: [null, { dueMs: dueMs[0], startMs: null, endMs: -Infinity, ...extra[0] }, { dueMs: dueMs[1], startMs: null, endMs: -Infinity, ...extra[1] }] });
    const step = (blinkState, elapsed, random = noRandom) => stepBlinks(blinkState, elapsed, DEFAULT_BLINK, random);

    test('the first blink of a figure is due 1.0 s, plus 1.7 s for each figure before it, plus a draw of up to 1 s', () => {
        const scene = twoFigures();

        expect(createBlinkState(scene, () => 0).layers.map(layer => layer?.dueMs)).toEqual([undefined, 2700, 4400]);
        expect(createBlinkState(scene, () => 0.5).layers.map(layer => layer?.dueMs)).toEqual([undefined, 3200, 4900]);
    });

    test('a figure that has no blink picture never blinks, so it has no state and wakes nothing', () => {
        const scene = parseBreathScene(manifestOf());
        const created = createBlinkState(scene, noRandom);

        expect(created.layers[0]).toBeNull();
        expect(stepBlinks({ layers: [null] }, 1e6, DEFAULT_BLINK, noRandom)).toEqual({ state: { layers: [null] }, variants: ['base'], untilMs: Infinity });
    });

    test('shows the base picture until a blink is due, and wakes at the due time', () => {
        const woken = step(state([1000, 9000]), 400);

        expect(woken.variants).toEqual(['base', 'base', 'base']);
        expect(woken.untilMs).toBe(600);
    });

    test('goes through half, closed and half again, each for its own time', () => {
        const start = step(state([1000, 90_000]), 1000);
        expect(start.variants[1]).toBe('half');
        expect(start.untilMs).toBe(70);

        expect(step(start.state, 1069).variants[1]).toBe('half');
        const closed = step(start.state, 1070);
        expect([closed.variants[1], closed.untilMs]).toEqual(['closed', 110]);
        const half = step(start.state, 1180);
        expect([half.variants[1], half.untilMs]).toEqual(['half', 70]);
    });

    test('is open again after the last step, and the next one is due a gap after the start of this one', () => {
        const start = step(state([1000, 90_000]), 1000, () => 0);
        const open = step(start.state, 1250);

        expect(open.variants[1]).toBe('base');
        expect(open.state.layers[1].dueMs).toBe(1000 + 3600);
        expect(step(state([1000, 90_000]), 1000, () => 0.9999999).state.layers[1].dueMs).toBe(1000 + 5400);
    });

    test('a due blink waits while another figure is blinking, and does not move its due time', () => {
        // The second figure blinks from 1000 to 1250, and the third was due at 1100.
        const first = step(state([1000, 1100]), 1000);
        const during = step(first.state, 1100);

        expect(during.variants).toEqual(['base', 'closed', 'base']);
        expect(during.state.layers[2].dueMs).toBe(1100);
        expect(during.state.layers[2].startMs).toBeNull();
    });

    test('a due blink starts only once the other figure has had its eyes open for 0.4 s', () => {
        const first = step(state([1000, 1100]), 1000);
        // The first blink ends at 1250, so the other may start at 1650.
        const justOpen = step(first.state, 1250);
        expect(justOpen.variants[2]).toBe('base');
        expect(justOpen.untilMs).toBe(400);

        expect(step(first.state, 1649).variants[2]).toBe('base');
        expect(step(first.state, 1650).variants[2]).toBe('half');
    });

    test('two figures that are due at the same moment do not start together: the first in the order goes first', () => {
        const both = step(state([1000, 1000]), 1000);

        expect(both.variants).toEqual(['base', 'half', 'base']);
    });

    test('waits for the other figure and no longer, so a due blink is not held up by a figure that is far from blinking', () => {
        const woken = step(state([1000, 1000], [{}, { dueMs: 50_000 }]), 1000);

        expect(woken.variants[1]).toBe('half');
        expect(woken.state.layers[2].startMs).toBeNull();
    });

    test('starts a blink that was due while the timer slept, once, and not the ones in between', () => {
        const woken = step(state([1000, 9000]), 60_000);

        expect(woken.variants[1]).toBe('half');
        // The next one is due a gap after this start, not after the due time that was missed.
        expect(woken.state.layers[1].dueMs).toBe(60_000 + 3600);
    });

    test('follows the steps of the plan in order', () => {
        const plan = { steps: [{ variant: 'closed', ms: 90 }, { variant: 'half', ms: 40 }], gapMs: [1000, 1000] };
        const blinkState = { layers: [{ dueMs: 0, startMs: null, endMs: -Infinity }] };
        const start = stepBlinks(blinkState, 0, plan, noRandom);

        expect(start.variants).toEqual(['closed']);
        expect(stepBlinks(start.state, 90, plan, noRandom).variants).toEqual(['half']);
        expect(stepBlinks(start.state, 130, plan, noRandom).variants).toEqual(['base']);
    });

    test('does not change the state it is given', () => {
        const before = state([1000, 1100]);
        const copy = structuredClone(before);

        step(before, 1000);

        expect(before).toEqual(copy);
    });
});

describe('pictureOf', () => {
    const [reisen, tewi] = parseBreathScene(manifestOf()).layers;

    test('is the base picture of the pose, or the picture of the blink where the figure has one', () => {
        expect(pictureOf(tewi, 'c', 'base')).toBe('hero-duo--tewi--c.webp');
        expect(pictureOf(tewi, 'b', 'base')).toBe('hero-duo--tewi--b.webp');
        expect(pictureOf(tewi, 'c', 'closed')).toBe('hero-duo--tewi--c--closed.webp');
        expect(pictureOf(tewi, 'b', 'half')).toBe('hero-duo--tewi--b--half.webp');
    });

    test('a figure with no blink pictures keeps its base picture through a blink', () => {
        expect(pictureOf(reisen, 'c', 'closed')).toBe('hero-duo--reisen--c.webp');
        expect([canBlink(reisen), canBlink(tewi)]).toEqual([false, true]);
    });

    test('a figure with a half picture only shows it for a closed eye', () => {
        const halfOnly = { ...tewi, images: { c: { base: 'a', half: 'ah' }, b: { base: 'b', half: 'bh' } } };

        expect(pictureOf(halfOnly, 'b', 'closed')).toBe('bh');
    });
});

describe('planScene', () => {
    const scene = parseBreathScene(manifestOf());
    const plan = (elapsed, blinkState = createBlinkState(scene, () => 0)) => planScene(blinkState, elapsed, scene, () => 0);

    test('starts each figure in the breath pose and waits for the first thing that changes', () => {
        // The first figure turns at 875 ms and the second, 0.27 of a breath in, at 401.5 ms. The only figure that blinks is the second, at 2700 ms.
        expect(plan(0)).toMatchObject({ files: ['hero-duo--reisen--b.webp', 'hero-duo--tewi--b.webp'], untilMs: 402 });
    });

    test('shows the blink picture of the pose that the figure is in', () => {
        expect(plan(2700).files[1]).toBe('hero-duo--tewi--c--half.webp');
    });

    test('shows the blink picture of the breath pose when the eyes close while the figure is in it', () => {
        const blinkState = { layers: [null, { dueMs: 0, startMs: null, endMs: -Infinity }] };

        // The second figure is a little over a quarter of a breath in at 100 ms, which is the first half of its breath.
        expect(planScene(blinkState, 100, scene, () => 0).files[1]).toBe('hero-duo--tewi--b--half.webp');
    });

    test('a figure that cannot blink waits for the breath alone', () => {
        const only = parseBreathScene(manifestOf({ layers: [manifestOf().layers[1]] }));

        expect(planScene(createBlinkState(only, () => 0), 0, only, () => 0).untilMs).toBe(875);
    });

    test('keeps the state of the blinks for the next call', () => {
        const first = plan(2700);

        expect(first.blinkState.layers[1].startMs).toBe(2700);
        expect(plan(2800, first.blinkState).blinkState.layers[1].dueMs).toBe(2700 + 3600);
    });
});
