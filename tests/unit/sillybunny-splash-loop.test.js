/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    BLINK_CLEARANCE_MS,
    BLINK_STAGGER_MS,
    createBlinkState as createBreathBlinkState,
    DEFAULT_BLINK as BREATH_DEFAULT_BLINK,
    FIRST_BLINK_MS,
    FIRST_BLINK_SPREAD_MS,
    parseBreathScene,
    stepBlinks as stepBreathBlinks,
} from '../../public/scripts/sillybunny-home/art-motion.js';

const splashSource = readFileSync(fileURLToPath(new URL('../../public/scripts/sillybunny-splash.js', import.meta.url)), 'utf8');
const loopSource = readFileSync(fileURLToPath(new URL('../../public/scripts/sillybunny-splash-loop.js', import.meta.url)), 'utf8');

// The markup of the real page, so the scripts are tested against the elements they will find and not against a copy.
const indexHtml = readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8');
const SPLASH_MARKUP = indexHtml.match(/<div class="sb-boot-splash">[\s\S]*?<\/p>\s*<\/div>/)[0];
const PRELOADER_MARKUP = `<div id="preloader">${SPLASH_MARKUP}</div>`;

const LOOP_FILE = 'splash-both--anim.json';

/** A scene of two figures for the splash, on the size of the still of `both`, which the test reads from the splash itself. */
function sceneOf(art, changes = {}) {
    return {
        id: 'splash-both',
        grid: { width: art.width, height: art.height },
        layers: [
            {
                id: 'reisen',
                z: 1,
                left: 6,
                top: 6,
                width: 120,
                height: 340,
                base: 'idle',
                frames: { idle: 'r-idle.webp', call: 'r-call.webp', 'idle-half': 'r-idle-half.webp', 'idle-closed': 'r-idle-closed.webp' },
            },
            {
                id: 'tewi',
                z: 2,
                left: 150,
                top: 60,
                width: 100,
                height: 290,
                base: 'idle',
                frames: { idle: 't-idle.webp', strike: 't-strike.webp', 'idle-half': 't-idle-half.webp', 'idle-closed': 't-idle-closed.webp' },
            },
        ],
        timelines: {
            reisen: {
                seconds: 2.4,
                keys: [{ at: 0, frame: 'idle' }, { at: 0.8, frame: 'call' }, { at: 1.8, frame: 'idle' }],
                effects: [{ kind: 'rings', frames: ['call'], from: 0.8, x: 100, y: 50 }],
            },
            tewi: {
                seconds: 3,
                keys: [{ at: 0, frame: 'idle' }, { at: 2, frame: 'strike' }],
                effects: [{ kind: 'burst', frames: ['strike'], from: 2, x: 30, y: 40 }],
            },
        },
        blinks: {
            steps: [{ variant: 'half', ms: 70 }, { variant: 'closed', ms: 110 }, { variant: 'half', ms: 70 }],
            gapMs: [4000, 5000],
            never: { reisen: ['call'], tewi: ['strike'] },
        },
        ...changes,
    };
}

const mediaQuery = { matches: false, listeners: new Set() };

function setSystemReducedMotion(matches) {
    mediaQuery.matches = matches;
    for (const listener of [...mediaQuery.listeners]) listener({ matches });
}

const flush = async () => {
    for (let round = 0; round < 12; round++) await Promise.resolve();
};

/** Draws the splash of `variant` with the real scripts, on a screen where one art pixel is one CSS pixel. */
function mountSplash({ variant = 'both', height = 768, ratio = 1 } = {}) {
    window.innerHeight = height;
    window.devicePixelRatio = ratio;
    document.body.innerHTML = PRELOADER_MARKUP;
    localStorage.clear();
    localStorage.setItem('sb-splash-character', variant);
    new window.Function(splashSource)();
    new window.Function(loopSource)();
    const preloader = document.getElementById('preloader');
    return {
        preloader,
        mascot: preloader.querySelector('.sb-boot-mascot'),
        splash: preloader.querySelector('.sb-boot-splash'),
        art: window.SillyBunnySplash.ART[variant],
    };
}

let fetched = [];
function serve(manifest, { status = 200 } = {}) {
    window.fetch = jest.fn((url) => {
        fetched.push(url);
        return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(manifest) });
    });
}

/** Starts the loop of `both` with the scene that `serve` was given, and waits until it has loaded. */
async function play(setup, options = {}) {
    window.SillyBunnySplash.LOOP_FILES.both = LOOP_FILE;
    const loop = window.SillyBunnySplashLoop.start(setup.preloader, { random: () => 0, ...options });
    await flush();
    return loop;
}

const layers = () => [...document.querySelectorAll('.sb-boot-loop-layer')];
const shown = () => layers().filter(image => image.style.visibility === 'visible').map(image => image.getAttribute('src').split('?')[0].replace('/img/sillybunny/', '')).sort();
const effectPaths = () => [...document.querySelectorAll('.sb-boot-effect path')].map(path => path.getAttribute('d') ?? '');

beforeEach(() => {
    jest.useFakeTimers();
    fetched = [];
    mediaQuery.matches = false;
    mediaQuery.listeners.clear();
    window.matchMedia = jest.fn(() => ({
        get matches() { return mediaQuery.matches; },
        addEventListener: (_type, listener) => mediaQuery.listeners.add(listener),
        removeEventListener: (_type, listener) => mediaQuery.listeners.delete(listener),
    }));
    window.HTMLImageElement.prototype.decode = () => Promise.resolve();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    delete document.hidden;
    jest.useRealTimers();
    jest.restoreAllMocks();
    document.body.innerHTML = '';
    document.body.className = '';
    delete window.SillyBunnySplash;
    delete window.SillyBunnySplashLoop;
    delete window.fetch;
    delete window.matchMedia;
    window.innerHeight = 768;
    window.devicePixelRatio = 1;
    localStorage.clear();
});

describe('reading a loop', () => {
    let art;
    beforeEach(() => {
        art = mountSplash().art;
    });
    const parse = (changes, size = art) => window.SillyBunnySplashLoop.parseLoopScene(sceneOf(art, changes), size);

    test('reads a scene as the exporter writes it, lowest z first, with the times of the keys in milliseconds', () => {
        const scene = parse();

        expect(scene.layers.map(layer => layer.id)).toEqual(['reisen', 'tewi']);
        expect(scene.timelines.reisen.lengthMs).toBe(2400);
        expect(scene.timelines.reisen.keys.map(key => key.atMs)).toEqual([0, 800, 1800]);
        expect(scene.timelines.reisen.effects[0]).toMatchObject({ kind: 'rings', frames: ['call'], fromMs: 800, x: 100, y: 50 });
        expect(scene.blinks.never).toEqual({ reisen: ['call'], tewi: ['strike'] });
    });

    test('a scene whose blinks are missing or null takes the defaults, with no never frames', () => {
        for (const blinks of [undefined, null]) {
            const scene = parse({ blinks });

            expect(scene.blinks.steps).toEqual(window.SillyBunnySplashLoop.DEFAULT_BLINK.steps);
            expect(scene.blinks.never).toEqual({});
        }
    });

    test('a layer with no timeline holds its base frame', () => {
        const manifest = sceneOf(art);
        delete manifest.timelines.tewi;

        const scene = window.SillyBunnySplashLoop.parseLoopScene(manifest, art);

        expect(scene.timelines.tewi).toBeUndefined();
    });

    test.each([
        ['a scene of another size than its still', { grid: { width: 10, height: 10 } }, /its still is/],
        ['no layers', { layers: [] }, /at least one layer/],
        ['a timeline whose first key is not at 0', { timelines: { reisen: { seconds: 2, keys: [{ at: 0.5, frame: 'idle' }] } } }, /must start at 0/],
        ['keys that do not rise', { timelines: { reisen: { seconds: 2, keys: [{ at: 0, frame: 'idle' }, { at: 1, frame: 'call' }, { at: 1, frame: 'idle' }] } } }, /strictly rising/],
        ['a key at the end of the loop', { timelines: { reisen: { seconds: 2, keys: [{ at: 0, frame: 'idle' }, { at: 2, frame: 'call' }] } } }, /below|to below/],
        ['a key that shows a frame the layer lacks', { timelines: { reisen: { seconds: 2, keys: [{ at: 0, frame: 'wave' }] } } }, /does not have/],
        ['a timeline for a layer that is not there', { timelines: { nobody: { seconds: 2, keys: [{ at: 0, frame: 'idle' }] } } }, /for the layer "nobody"/],
        ['an effect of an unknown kind', { timelines: { reisen: { seconds: 2, keys: [{ at: 0, frame: 'idle' }], effects: [{ kind: 'glow', frames: ['idle'], from: 0, x: 0, y: 0 }] } } }, /unknown kind/],
        ['an effect on a frame that is not there', { timelines: { reisen: { seconds: 2, keys: [{ at: 0, frame: 'idle' }], effects: [{ kind: 'puff', frames: ['wave'], from: 0, x: 0, y: 0 }] } } }, /frames that the layer has/],
        ['a never frame of a layer that is not there', { blinks: { steps: [{ variant: 'half', ms: 70 }], gapMs: [1, 2], never: { nobody: ['idle'] } } }, /names the layer|has none|nobody/],
        ['a blink step that shows the base picture', { blinks: { steps: [{ variant: 'base', ms: 70 }], gapMs: [1, 2] } }, /unknown kind/],
        ['a blink wait the wrong way round', { blinks: { steps: [{ variant: 'half', ms: 70 }], gapMs: [3000, 2000] } }, /below the shortest/],
    ])('refuses %s', (_name, changes, message) => {
        expect(() => parse(changes)).toThrow(message);
    });

    test.each([
        ['a frame in a folder', layers => { layers[0].frames.idle = 'img/r-idle.webp'; }, /plain file name/],
        ['a base frame that is not a frame', layers => { layers[0].base = 'wave'; }, /base frame/],
        ['a layer with a fraction for a size', layers => { layers[0].width = 12.5; }, /whole number/],
    ])('refuses a layer with %s', (_name, change, message) => {
        const manifest = sceneOf(art);
        change(manifest.layers);

        expect(() => window.SillyBunnySplashLoop.parseLoopScene(manifest, art)).toThrow(message);
    });

    test('refuses what is not an object', () => {
        expect(() => window.SillyBunnySplashLoop.parseLoopScene(null, art)).toThrow(/must be an object/);
    });
});

describe('the names of the pictures', () => {
    let art;
    beforeEach(() => {
        art = mountSplash().art;
    });

    test.each([
        ['a folder', 'img/r-idle.webp'],
        ['a way up', '../r-idle.webp'],
        ['only a way up', '..'],
        ['a name that starts with a dot', '.hidden.webp'],
        ['a query', 'r-idle.webp?x=1'],
        ['a fragment', 'r-idle.webp#top'],
        ['an escaped slash', 'r%2fidle.webp'],
        ['a backslash', 'r\\idle.webp'],
        ['a space', 'r idle.webp'],
        ['nothing', ''],
    ])('refuses %s as the name of a frame', (_name, fileName) => {
        const manifest = sceneOf(art);
        manifest.layers[0].frames.idle = fileName;

        expect(() => window.SillyBunnySplashLoop.parseLoopScene(manifest, art)).toThrow(/plain file name/);
    });

    test('accepts the names that the exporter writes', () => {
        const manifest = sceneOf(art);
        manifest.layers[0].frames.idle = 'splash3-reisen--idle@native.webp';

        expect(() => window.SillyBunnySplashLoop.parseLoopScene(manifest, art)).not.toThrow();
    });
});

describe('the timelines', () => {
    let art;
    let scene;
    let reisen;
    let tewi;
    beforeEach(() => {
        art = mountSplash().art;
        scene = window.SillyBunnySplashLoop.parseLoopScene(sceneOf(art), art);
        [reisen, tewi] = scene.layers;
    });
    const frameOf = (layer, ms) => window.SillyBunnySplashLoop.frameAt(layer, scene.timelines[layer.id], ms);
    const untilChange = (layer, ms) => window.SillyBunnySplashLoop.msUntilKeyChange(scene.timelines[layer.id], ms);

    test('a key holds its frame until the next, the last holds until the loop starts again, and there is no tweening', () => {
        expect([0, 799, 800, 1799, 1800, 2399].map(ms => frameOf(reisen, ms))).toEqual(['idle', 'idle', 'call', 'call', 'idle', 'idle']);
    });

    test('the loop starts again at its first key, and each figure has a loop of its own length', () => {
        expect(frameOf(reisen, 2400 + 800)).toBe('call');
        expect(frameOf(tewi, 2000)).toBe('strike');
        expect(frameOf(tewi, 3000)).toBe('idle');
        // At 5000 ms Reisen is 200 ms into her second lap and Tewi 2000 ms into her second.
        expect([frameOf(reisen, 5000), frameOf(tewi, 5000)]).toEqual(['idle', 'strike']);
    });

    test('waits until the next key, then until the end of the loop, and never less than a millisecond', () => {
        expect([0, 799, 800, 1800, 2399].map(ms => untilChange(reisen, ms))).toEqual([800, 1, 1000, 600, 1]);
    });

    test('a timeline with one key never changes its frame, and a layer with none holds its base', () => {
        const single = { lengthMs: 1000, keys: [{ atMs: 0, frame: 'idle' }], effects: [] };

        expect(window.SillyBunnySplashLoop.msUntilKeyChange(single, 400)).toBe(Infinity);
        expect(window.SillyBunnySplashLoop.msUntilKeyChange(undefined, 400)).toBe(Infinity);
        expect(window.SillyBunnySplashLoop.frameAt(reisen, undefined, 123456)).toBe('idle');
    });

    test('a blink shows the frame with its variant, and the frame itself where there is no such picture', () => {
        const { pictureName } = window.SillyBunnySplashLoop;

        expect(pictureName(reisen, 'idle', 'half')).toBe('idle-half');
        expect(pictureName(reisen, 'call', 'closed')).toBe('call');
        expect(pictureName(reisen, 'idle', 'base')).toBe('idle');
    });
});

describe('the blinks', () => {
    let art;
    let scene;
    let reisen;
    let tewi;
    beforeEach(() => {
        art = mountSplash().art;
        scene = window.SillyBunnySplashLoop.parseLoopScene(sceneOf(art), art);
        [reisen, tewi] = scene.layers;
    });
    const allowed = (layer, ms) => window.SillyBunnySplashLoop.blinkAllowed(scene, layer, ms);

    test('a blink is not allowed if the timeline puts the figure in a frame that it must not blink in at any moment of the blink', () => {
        // A blink is 250 ms long. Reisen is in her call from 800 ms to 1800 ms of a loop of 2400.
        expect([100, 700, 1000, 1700, 1850, 2300, 3100].map(ms => allowed(reisen, ms))).toEqual([true, false, false, false, true, true, false]);
        // Tewi strikes from 2000 ms of a loop of 3000.
        expect([0, 1700, 1900, 2000, 2900, 3000].map(ms => allowed(tewi, ms))).toEqual([true, true, false, false, false, true]);
    });

    test('a layer with no never frames always may', () => {
        const free = { ...scene, blinks: { ...scene.blinks, never: {} } };

        expect(window.SillyBunnySplashLoop.blinkAllowed(free, reisen, 1000)).toBe(true);
    });

    test('the first blink of each figure is due 1.0 s plus 1.7 s for each figure before it, plus a draw of up to 1 s', () => {
        const { createBlinkState } = window.SillyBunnySplashLoop;

        expect(createBlinkState(scene, () => 0).layers.map(layer => layer.dueMs)).toEqual([1000, 2700]);
        expect(createBlinkState(scene, () => 0.5).layers.map(layer => layer.dueMs)).toEqual([1500, 3200]);
    });

    test('a figure with no blink pictures never blinks and wakes nothing', () => {
        const bare = window.SillyBunnySplashLoop.parseLoopScene(sceneOf(art, { layers: [{ ...sceneOf(art).layers[0], frames: { idle: 'r-idle.webp', call: 'r-call.webp' } }], timelines: {}, blinks: null }), art);

        expect(window.SillyBunnySplashLoop.createBlinkState(bare, () => 0).layers).toEqual([null]);
    });

    test('a blink that the timeline holds back keeps its due time and asks again at the next key, not on every millisecond', () => {
        const { stepBlinks } = window.SillyBunnySplashLoop;
        const state = { layers: [{ dueMs: 1000, startMs: null, endMs: -Infinity }, null] };

        const held = stepBlinks(state, 1100, scene.blinks, () => 0, () => 700);

        expect(held.variants).toEqual(['base', 'base']);
        expect(held.state.layers[0]).toEqual({ dueMs: 1000, startMs: null, endMs: -Infinity });
        expect(held.untilMs).toBe(700);
    });

    test('goes through half, closed and half again, and the next blink is due a gap after the start of this one', () => {
        const { stepBlinks } = window.SillyBunnySplashLoop;
        const state = { layers: [{ dueMs: 1000, startMs: null, endMs: -Infinity }, null] };
        const yes = () => true;

        const at = (current, ms) => stepBlinks(current, ms, scene.blinks, () => 0, yes);
        const first = at(state, 1000);

        expect([first.variants[0], first.untilMs]).toEqual(['half', 70]);
        expect(at(first.state, 1070).variants[0]).toBe('closed');
        expect(at(first.state, 1180).variants[0]).toBe('half');
        const after = at(first.state, 1250);
        expect(after.variants[0]).toBe('base');
        expect(after.state.layers[0].dueMs).toBe(1000 + 4000);
    });

    describe('held to the rules of the art that is not a splash, which are the same rules written for a module', () => {
        const eyes = { c: { base: 'a', half: 'ah', closed: 'ac' }, b: { base: 'b', half: 'bh', closed: 'bc' } };

        /** The same two figures as a module scene, with the plan that the loop scene has or, when there is none, with none. */
        function twinScenes(blinks) {
            const loopScene = window.SillyBunnySplashLoop.parseLoopScene({
                ...sceneOf(art),
                blinks,
            }, art);
            const breath = parseBreathScene({
                scene: 'twin',
                grid: { width: 50, height: 60 },
                rhythm: { cycleSeconds: 3.5, breathsPerCycle: 2 },
                poses: ['c', 'b'],
                backdrop: null,
                layers: [
                    { id: 'one', z: 1, left: 0, top: 0, width: 10, height: 10, waist: 5, images: eyes },
                    { id: 'two', z: 2, left: 20, top: 0, width: 10, height: 10, waist: 5, images: eyes },
                ],
                ...(blinks ? { blinks: { steps: blinks.steps, gapMs: blinks.gapMs } } : {}),
            });
            return { loopScene, breath };
        }

        /** Walks both through the same draws and says where they differ, and how often a blink had to wait for another. */
        function walk({ loopScene, breath }, { untilMs = 60_000, stepMs = 23 } = {}) {
            const loop = window.SillyBunnySplashLoop;
            let draws = 0;
            const draw = () => { draws += 1; return ((draws * 0.37) % 1); };
            let breathDraws = 0;
            const breathDraw = () => { breathDraws += 1; return ((breathDraws * 0.37) % 1); };
            let loopState = loop.createBlinkState(loopScene, draw);
            let breathState = createBreathBlinkState(breath, breathDraw);
            const seen = new Set();
            const differences = [];
            let waits = 0;
            for (let ms = 0; ms < untilMs; ms += stepMs) {
                const fromLoop = loop.stepBlinks(loopState, ms, loopScene.blinks, draw, () => true);
                const fromModule = stepBreathBlinks(breathState, ms, breath.blink, breathDraw);
                loopState = fromLoop.state;
                breathState = fromModule.state;
                if (JSON.stringify([fromLoop.variants, fromLoop.untilMs]) !== JSON.stringify([fromModule.variants, fromModule.untilMs])) {
                    differences.push([ms, fromLoop.variants, fromModule.variants, fromLoop.untilMs, fromModule.untilMs]);
                }
                if (fromModule.state.layers.some(layer => layer && layer.startMs === null && ms >= layer.dueMs)) waits += 1;
                fromLoop.variants.forEach(variant => seen.add(variant));
            }
            return { differences: differences.slice(0, 3), seen: [...seen].sort(), waits, drawsAgree: draws === breathDraws };
        }

        test('has the same timings and the same default blink', () => {
            const loop = window.SillyBunnySplashLoop;

            expect([loop.FIRST_BLINK_MS, loop.FIRST_BLINK_SPREAD_MS, loop.BLINK_STAGGER_MS, loop.BLINK_CLEARANCE_MS])
                .toEqual([FIRST_BLINK_MS, FIRST_BLINK_SPREAD_MS, BLINK_STAGGER_MS, BLINK_CLEARANCE_MS]);
            expect(loop.DEFAULT_BLINK).toEqual(BREATH_DEFAULT_BLINK);
        });

        test('takes the same default blink for a scene that writes none', () => {
            const { loopScene, breath } = twinScenes(undefined);

            expect({ steps: loopScene.blinks.steps, gapMs: loopScene.blinks.gapMs }).toEqual({ steps: breath.blink.steps, gapMs: breath.blink.gapMs });
        });

        test('gives the same blinks over a minute with the default plan', () => {
            const result = walk(twinScenes(undefined));

            expect(result.differences).toEqual([]);
            expect(result.seen).toEqual(['base', 'closed', 'half']);
            expect(result.drawsAgree).toBe(true);
        });

        test('gives the same blinks over a minute with a plan whose gaps are short enough that figures collide, and they do wait', () => {
            const plan = { steps: scene.blinks.steps, gapMs: [300, 700], never: {} };
            const result = walk(twinScenes(plan));

            expect(result.waits).toBeGreaterThan(50);
            expect(result.differences).toEqual([]);
            expect(result.drawsAgree).toBe(true);
        });

        // The step of a figure that is due is held until the other has had its eyes open for the clearance, so the two are
        // never closed together and never close in a row.
        test('lets one of two figures that are due together blink, and the other once the clearance has passed', () => {
            const loop = window.SillyBunnySplashLoop;
            const { loopScene, breath } = twinScenes(undefined);
            const due = { layers: [{ dueMs: 1000, startMs: null, endMs: -Infinity }, { dueMs: 1000, startMs: null, endMs: -Infinity }] };
            const length = loopScene.blinks.steps.reduce((sum, step) => sum + step.ms, 0);
            const secondStarts = length + BLINK_CLEARANCE_MS + 1000;
            const variantsAt = (ms) => {
                const fromLoop = loop.stepBlinks(due, 1000, loopScene.blinks, () => 0, () => true);
                const fromModule = stepBreathBlinks(due, 1000, breath.blink, () => 0);
                const laterLoop = loop.stepBlinks(fromLoop.state, ms, loopScene.blinks, () => 0, () => true);
                const laterModule = stepBreathBlinks(fromModule.state, ms, breath.blink, () => 0);
                return [fromLoop.variants, fromModule.variants, laterLoop.variants, laterModule.variants];
            };

            const [firstLoop, firstModule, justBeforeLoop, justBeforeModule] = variantsAt(secondStarts - 1);
            const [, , atLoop, atModule] = variantsAt(secondStarts);

            expect([firstLoop, firstModule]).toEqual([['half', 'base'], ['half', 'base']]);
            expect([justBeforeLoop, justBeforeModule]).toEqual([['base', 'base'], ['base', 'base']]);
            expect([atLoop, atModule]).toEqual([['base', 'half'], ['base', 'half']]);
        });
    });
});

describe('the effects', () => {
    beforeEach(() => {
        mountSplash();
    });

    test('are made of whole art pixels, so they stay on the grid of the picture', () => {
        const { effectRects } = window.SillyBunnySplashLoop;

        for (const kind of ['rings', 'burst', 'puff']) {
            for (let age = 0; age < 1500; age += 50) {
                for (const rect of effectRects(kind, age)) {
                    expect(rect.every(value => Number.isInteger(value))).toBe(true);
                    expect(rect[2]).toBeGreaterThan(0);
                    expect(rect[3]).toBeGreaterThan(0);
                }
            }
        }
    });

    test.each([
        ['rings', 0, 1300],
        ['burst', 0, 500],
        ['puff', 0, 1300],
    ])('%s are drawn when they start, and are gone once they are over', (kind, start, over) => {
        const { effectRects } = window.SillyBunnySplashLoop;

        expect(effectRects(kind, start).length).toBeGreaterThan(0);
        expect(effectRects(kind, over)).toEqual([]);
    });

    test('rings grow with their age', () => {
        const { effectRects } = window.SillyBunnySplashLoop;
        const width = age => Math.max(...effectRects('rings', age).map(rect => rect[0] + rect[2])) - Math.min(...effectRects('rings', age).map(rect => rect[0]));

        expect(width(300)).toBeGreaterThan(width(0));
    });
});

describe('playing a loop', () => {
    test('puts the still in a box with the pictures over it, hides the still, and shows the first frame of every figure', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));

        await play(setup);

        const box = setup.mascot.parentElement;
        expect(box.className).toBe('sb-boot-loop');
        expect(box.parentElement).toBe(setup.splash);
        expect(box.getAttribute('aria-hidden')).toBe('true');
        expect(layers()).toHaveLength(8);
        expect(shown()).toEqual(['r-idle.webp', 't-idle.webp']);
        expect(setup.mascot.style.visibility).toBe('hidden');
        expect(fetched).toEqual([`/img/sillybunny/${LOOP_FILE}?v=${window.SillyBunnySplash.ART_VERSION}`]);
    });

    test('places each picture at its art pixels, at the size of an art pixel that the splash sets, and again when that changes', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        await play(setup);
        const reisen = layers().find(image => image.getAttribute('src').includes('r-idle.webp?'));

        expect([reisen.style.left, reisen.style.top, reisen.style.width, reisen.style.height]).toEqual(['6px', '6px', '120px', '340px']);

        // A taller screen holds two steps: the splash sets 2px for an art pixel, and the pictures follow.
        window.innerHeight = 2000;
        window.dispatchEvent(new Event('resize'));
        await flush();

        expect(setup.splash.style.getPropertyValue('--sb-boot-px')).toBe('2px');
        expect([reisen.style.left, reisen.style.top, reisen.style.width, reisen.style.height]).toEqual(['12px', '12px', '240px', '680px']);
    });

    test('a figure changes its frame at its keys, each on a loop of its own, with one timer and no frame loop', async () => {
        const setup = mountSplash();
        // Without pictures to blink with, so that the blinks do not come into it.
        const manifest = sceneOf(setup.art);
        for (const layer of manifest.layers) {
            layer.frames = Object.fromEntries(Object.entries(layer.frames).filter(([name]) => !/-(half|closed)$/.test(name)));
        }
        serve(manifest);
        const requestFrame = jest.spyOn(window, 'requestAnimationFrame');
        await play(setup);
        expect(jest.getTimerCount()).toBe(1);

        jest.advanceTimersByTime(801);
        expect(shown()).toEqual(['r-call.webp', 't-idle.webp']);

        jest.advanceTimersByTime(1000);
        expect(shown()).toEqual(['r-idle.webp', 't-idle.webp']);

        jest.advanceTimersByTime(200);
        // Tewi strikes 2000 ms in and Reisen starts her loop again at 2400.
        expect(shown()).toEqual(['r-idle.webp', 't-strike.webp']);
        expect(jest.getTimerCount()).toBe(1);
        expect(requestFrame).not.toHaveBeenCalled();
    });

    test('a blink that falls in a never frame waits for the timeline, and then plays in the frame that the figure is in', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        await play(setup);

        // Reisen is due to blink at 1000 ms, in the middle of her call, and is not allowed to.
        jest.advanceTimersByTime(1500);
        expect(shown()).toEqual(['r-call.webp', 't-idle.webp']);

        jest.advanceTimersByTime(301);
        expect(shown()).toEqual(['r-idle-half.webp', 't-idle.webp']);
        jest.advanceTimersByTime(70);
        expect(shown()).toEqual(['r-idle-closed.webp', 't-idle.webp']);
        jest.advanceTimersByTime(110);
        expect(shown()).toEqual(['r-idle-half.webp', 't-idle.webp']);
        jest.advanceTimersByTime(70);
        // Tewi has started her strike at 2000 ms.
        expect(shown()).toEqual(['r-idle.webp', 't-strike.webp']);
    });

    test('an effect is drawn while its frame shows and is cleared after, in steps', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        await play(setup);
        expect(effectPaths()).toEqual(['', '']);

        jest.advanceTimersByTime(801);
        const first = effectPaths();
        expect(first[0]).not.toBe('');
        expect(first[1]).toBe('');

        jest.advanceTimersByTime(300);
        expect(effectPaths()[0]).not.toBe(first[0]);

        jest.advanceTimersByTime(800);
        expect(effectPaths()[0]).toBe('');
    });

    test('draws the effect at its origin in art pixels from the corner of the layer', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art, { timelines: { reisen: { seconds: 2, keys: [{ at: 0, frame: 'call' }], effects: [{ kind: 'burst', frames: ['call'], from: 0, x: 40, y: 30 }] } } }));
        await play(setup);

        const svg = document.querySelector('.sb-boot-effect');
        // A burst at its start is eight blocks of 2 by 2 around the origin, three art pixels out.
        expect(svg.getAttribute('viewBox')).toBe(`0 0 ${setup.art.width} ${setup.art.height}`);
        expect([svg.style.left, svg.style.top, svg.style.width, svg.style.height]).toEqual(['0px', '0px', `${setup.art.width}px`, `${setup.art.height}px`]);
        // The layer is at 6, 6 and the effect at 40, 30 in it, so the blocks start at 46 and 36 less one, and 3 art pixels out.
        expect(svg.querySelector('path').getAttribute('d')).toContain('M48 35h2v2h-2z');
    });

    test('is not cut off by the box of its layer: a ring at the edge of the figure reaches into the picture around it', async () => {
        const setup = mountSplash();
        const manifest = sceneOf(setup.art, { timelines: { reisen: { seconds: 2, keys: [{ at: 0, frame: 'call' }], effects: [{ kind: 'rings', frames: ['call'], from: 0, x: 118, y: 5 }] } } });
        serve(manifest);
        await play(setup);

        jest.advanceTimersByTime(500);

        const path = document.querySelector('.sb-boot-effect path').getAttribute('d');
        const reach = Math.max(...[...path.matchAll(/M(-?\d+) /g)].map(match => Number(match[1])));
        const layer = manifest.layers[0];
        expect(reach).toBeGreaterThan(layer.left + layer.width);
        expect(document.querySelector('.sb-boot-effect').getAttribute('viewBox')).toBe(`0 0 ${manifest.grid.width} ${manifest.grid.height}`);
    });

    test('keeps the sparkles on the grid of the picture, which the splash looks up now that the picture is in a box', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        await play(setup);

        window.innerHeight = 2000;
        window.dispatchEvent(new Event('resize'));

        expect(setup.splash.style.getPropertyValue('--sb-boot-px')).toBe('2px');
        expect(setup.mascot.parentElement.style.getPropertyValue('--sb-boot-px')).toBe('');
    });
});

describe('when it may not move', () => {
    test('a splash with no loop for its variant loads nothing', () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));

        const loop = window.SillyBunnySplashLoop.start(setup.preloader);

        expect(loop).toBeNull();
        expect(window.fetch).not.toHaveBeenCalled();
    });

    test.each([
        ['the system setting', () => { mediaQuery.matches = true; }],
        ['the saved setting that the splash mirrors', setup => setup.preloader.classList.add('sb-boot-reduced')],
        ['the class that the app puts on the body', () => document.body.classList.add('reduced-motion')],
    ])('under Reduced Motion from %s nothing is loaded and the still stays', async (_name, apply) => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        apply(setup);

        await play(setup);

        expect(window.fetch).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
        expect(setup.mascot.style.visibility).toBe('');
        expect(layers()).toHaveLength(0);
    });

    test('a fit that shrinks the picture by a fraction keeps the still, because its art pixels are not whole device pixels', async () => {
        const setup = mountSplash({ height: 300 });
        serve(sceneOf(setup.art));
        expect(setup.mascot.getAttribute('data-fit')).toBe('smooth');

        await play(setup);

        expect(window.fetch).not.toHaveBeenCalled();
        expect(setup.mascot.style.visibility).toBe('');
    });

    test('goes back to the still when the fit turns smooth while it plays, and plays again when it is whole again', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        await play(setup);
        expect(jest.getTimerCount()).toBe(1);

        window.innerHeight = 300;
        window.dispatchEvent(new Event('resize'));
        await flush();

        expect(jest.getTimerCount()).toBe(0);
        expect(setup.mascot.style.visibility).toBe('');
        expect(layers().every(image => image.style.display === 'none')).toBe(true);

        window.innerHeight = 768;
        window.dispatchEvent(new Event('resize'));
        await flush();

        expect(jest.getTimerCount()).toBe(1);
        expect(setup.mascot.style.visibility).toBe('hidden');
        expect(window.fetch).toHaveBeenCalledTimes(1);
    });

    test('stops, drops its timer and shows the still when Reduced Motion comes on while it plays, from any of the three', async () => {
        for (const turnOn of [
            () => setSystemReducedMotion(true),
            () => document.body.classList.add('reduced-motion'),
            (setup) => setup.preloader.classList.add('sb-boot-reduced'),
        ]) {
            mediaQuery.matches = false;
            document.body.className = '';
            const setup = mountSplash();
            serve(sceneOf(setup.art));
            await play(setup);
            expect(jest.getTimerCount()).toBe(1);

            turnOn(setup);
            await flush();

            expect(jest.getTimerCount()).toBe(0);
            expect(setup.mascot.style.visibility).toBe('');
            expect(layers().every(image => image.style.display === 'none')).toBe(true);
            jest.advanceTimersByTime(5000);
            expect(shown()).toEqual(['r-idle.webp', 't-idle.webp']);
        }
    });

    test('ends for good when the preloader is removed: no timer, no listener, no picture', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        const remove = jest.spyOn(window, 'removeEventListener');
        // The splash script keeps a query of its own for the screen ratio, which is not the loop's.
        const before = mediaQuery.listeners.size;
        await play(setup);
        expect(mediaQuery.listeners.size).toBe(before + 1);
        expect(jest.getTimerCount()).toBe(1);

        setup.preloader.remove();
        await flush();

        expect(jest.getTimerCount()).toBe(0);
        expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
        expect(mediaQuery.listeners.size).toBe(before);
        expect(document.querySelectorAll('.sb-boot-loop-layer, .sb-boot-effect')).toHaveLength(0);
    });

    test('ends for good when the boot guard empties the preloader and leaves it in the page', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        await play(setup);
        expect(jest.getTimerCount()).toBe(1);

        setup.preloader.innerHTML = '';
        await flush();

        expect(document.documentElement.contains(setup.preloader)).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        expect(document.querySelectorAll('.sb-boot-loop-layer, .sb-boot-effect')).toHaveLength(0);
    });

    test('stops while the document is hidden, shows the still, and plays again when it is shown', async () => {
        const setHidden = (hidden) => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
            document.dispatchEvent(new Event('visibilitychange'));
        };
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        await play(setup);
        expect(jest.getTimerCount()).toBe(1);

        setHidden(true);
        await flush();

        expect(jest.getTimerCount()).toBe(0);
        expect(setup.mascot.style.visibility).toBe('');
        expect(layers().every(image => image.style.display === 'none')).toBe(true);
        jest.advanceTimersByTime(5000);
        expect(shown()).toEqual(['r-idle.webp', 't-idle.webp']);

        setHidden(false);
        await flush();

        expect(jest.getTimerCount()).toBe(1);
        expect(setup.mascot.style.visibility).toBe('hidden');
        expect(window.fetch).toHaveBeenCalledTimes(1);
    });

    test('asks for nothing while the document is hidden from the start', async () => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        const setup = mountSplash();
        serve(sceneOf(setup.art));

        await play(setup);

        expect(window.fetch).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('takes its listener for the visibility of the document away when it ends', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        const remove = jest.spyOn(document, 'removeEventListener');
        await play(setup);

        setup.preloader.remove();
        await flush();

        expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    });

    test('keeps the still, says so, and stops when a frame cannot be drawn after it has played', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        let calls = 0;
        await play(setup, { now: () => { calls += 1; if (calls > 1) throw new Error('the clock broke'); return 0; } });

        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(String(console.warn.mock.calls[0][0])).toMatch(/its loop stopped/);
        expect(jest.getTimerCount()).toBe(0);
        expect(setup.mascot.style.visibility).toBe('');
        expect(layers()).toHaveLength(0);
    });

    test('a splash that is gone before the frames arrive shows nothing and keeps nothing', async () => {
        const setup = mountSplash();
        let release;
        window.fetch = jest.fn(() => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(sceneOf(setup.art)) }); }));
        await play(setup);

        setup.preloader.remove();
        await flush();
        release();
        await flush();

        expect(jest.getTimerCount()).toBe(0);
        expect(document.querySelectorAll('.sb-boot-loop-layer')).toHaveLength(0);
    });
});

describe('when the frames cannot be loaded', () => {
    test.each([
        ['the file is not found', setup => serve(sceneOf(setup.art), { status: 404 }), /answered 404/],
        ['the file is not a loop', setup => serve({ id: 'x' }), /grid width/],
        ['the loop is for another picture', setup => serve(sceneOf(setup.art, { grid: { width: 5, height: 5 } })), /its still is/],
    ])('keeps the still, says so once and leaves nothing behind when %s', async (_name, arrange, message) => {
        const setup = mountSplash();
        arrange(setup);

        await play(setup);

        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(String(console.warn.mock.calls[0][1])).toMatch(message);
        expect(setup.mascot.style.visibility).toBe('');
        expect(setup.mascot.parentElement).toBe(setup.splash);
        expect(layers()).toHaveLength(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('keeps the still when a picture does not decode, and does not put any in the page', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art));
        window.HTMLImageElement.prototype.decode = () => Promise.reject(new Error('broken file'));

        await play(setup);

        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(setup.mascot.style.visibility).toBe('');
        expect(layers()).toHaveLength(0);
    });

    test('does not ask again after a failure, however often the page changes', async () => {
        const setup = mountSplash();
        serve(sceneOf(setup.art), { status: 500 });
        const loop = await play(setup);

        loop.refresh();
        document.body.classList.add('anything');
        await flush();

        expect(window.fetch).toHaveBeenCalledTimes(1);
    });
});

describe('the splash script', () => {
    const scripts = () => [...document.head.querySelectorAll('script[src*="sillybunny-splash-loop"]')];

    function drawSplash({ variant = 'both', loopFor = ['both'], reduced = false, mirrored = false } = {}) {
        document.head.querySelectorAll('script[src*="sillybunny-splash-loop"]').forEach(node => node.remove());
        document.body.innerHTML = PRELOADER_MARKUP;
        localStorage.clear();
        localStorage.setItem('sb-splash-character', variant);
        if (mirrored) localStorage.setItem('sb-reduced-motion', 'true');
        mediaQuery.matches = reduced;
        // The table is a variable of the script, so the test gives the script a table that has the loop.
        const source = splashSource.replace('var LOOP_FILES = {};', `var LOOP_FILES = ${JSON.stringify(Object.fromEntries(loopFor.map(name => [name, `splash-${name}--anim.json`])))};`);
        new window.Function(source)();
        return document.querySelector('.sb-boot-mascot');
    }

    afterEach(() => {
        document.head.querySelectorAll('script[src*="sillybunny-splash-loop"]').forEach(node => node.remove());
    });

    test('ships no loop yet, so nothing is requested and the first paint is what it was', () => {
        document.body.innerHTML = PRELOADER_MARKUP;
        new window.Function(splashSource)();
        jest.runAllTimers();

        expect(window.SillyBunnySplash.LOOP_FILES).toEqual({});
        expect(scripts()).toHaveLength(0);
    });

    test('every loop that it lists is a file that is shipped, and is for a variant that it has', () => {
        document.body.innerHTML = PRELOADER_MARKUP;
        new window.Function(splashSource)();
        const images = fileURLToPath(new URL('../../public/img/sillybunny/', import.meta.url));

        for (const [variant, file] of Object.entries(window.SillyBunnySplash.LOOP_FILES)) {
            expect(Object.keys(window.SillyBunnySplash.ART)).toContain(variant);
            expect(existsSync(`${images}${file}`)).toBe(true);
        }
    });

    test('is not in index.html, so it is not a startup script of the page', () => {
        expect(indexHtml).not.toContain('sillybunny-splash-loop');
    });

    test('loads the script of the loop only after the still has loaded and a frame has passed', () => {
        const mascot = drawSplash();
        expect(scripts()).toHaveLength(0);

        mascot.dispatchEvent(new Event('load'));
        expect(scripts()).toHaveLength(0);

        jest.runAllTimers();
        expect(scripts()).toHaveLength(1);
        expect(scripts()[0].getAttribute('src')).toBe(`/scripts/sillybunny-splash-loop.js?v=${window.SillyBunnySplash.LOOP_SCRIPT_VERSION}`);
        expect(scripts()[0].async).toBe(true);
    });

    test('waits for the main thread to be idle, for no longer than the limit, and asks the browser to wait that long at most', () => {
        const idle = jest.fn();
        window.requestIdleCallback = idle;
        const mascot = drawSplash();

        mascot.dispatchEvent(new Event('load'));
        jest.runAllTimers();

        expect(scripts()).toHaveLength(0);
        expect(idle).toHaveBeenCalledTimes(1);
        expect(idle.mock.calls[0][1]).toEqual({ timeout: window.SillyBunnySplash.LOOP_IDLE_LIMIT_MS });
        idle.mock.calls[0][0]();
        expect(scripts()).toHaveLength(1);
        delete window.requestIdleCallback;
    });

    test('where there are no idle callbacks it waits half the limit', () => {
        delete window.requestIdleCallback;
        const mascot = drawSplash();
        const limit = window.SillyBunnySplash.LOOP_IDLE_LIMIT_MS;

        mascot.dispatchEvent(new Event('load'));
        jest.advanceTimersByTime(100);
        expect(scripts()).toHaveLength(0);
        jest.advanceTimersByTime(limit / 2);

        expect(scripts()).toHaveLength(1);
    });

    test('does not load the script when the splash is gone by the time the main thread is idle', () => {
        const idle = jest.fn();
        window.requestIdleCallback = idle;
        const mascot = drawSplash();
        mascot.dispatchEvent(new Event('load'));
        jest.runAllTimers();

        document.getElementById('preloader').remove();
        idle.mock.calls[0][0]();

        expect(scripts()).toHaveLength(0);
        delete window.requestIdleCallback;
    });

    test('starts the loop when its script has loaded, for the splash that is up', () => {
        const mascot = drawSplash();
        const start = jest.fn();
        window.SillyBunnySplashLoop = { start };

        mascot.dispatchEvent(new Event('load'));
        jest.runAllTimers();
        scripts()[0].onload();

        expect(start).toHaveBeenCalledWith(document.getElementById('preloader'));
    });

    test('loads nothing for a variant with no loop, under Reduced Motion, or once the splash has gone', () => {
        drawSplash({ variant: 'tewi', loopFor: ['both'] }).dispatchEvent(new Event('load'));
        jest.runAllTimers();
        expect(scripts()).toHaveLength(0);

        drawSplash({ reduced: true }).dispatchEvent(new Event('load'));
        jest.runAllTimers();
        expect(scripts()).toHaveLength(0);

        drawSplash({ mirrored: true }).dispatchEvent(new Event('load'));
        jest.runAllTimers();
        expect(scripts()).toHaveLength(0);

        const mascot = drawSplash();
        mascot.dispatchEvent(new Event('load'));
        document.getElementById('preloader').remove();
        jest.runAllTimers();
        expect(scripts()).toHaveLength(0);
    });
});
