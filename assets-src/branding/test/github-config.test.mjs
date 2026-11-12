import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseGithubConfig, slotAsset } from '../scripts/lib/github-config.mjs';
import { contrastRatio } from '../scripts/lib/github-colour.mjs';

const REAL = JSON.parse(readFileSync(fileURLToPath(new URL('../github-config.json', import.meta.url)), 'utf8'));
const clone = () => structuredClone(REAL);
const layout = (config, id) => config.layouts.find((entry) => entry.id === id);
const GOOD_SHADOW = { colour: 'plum', alpha: 0.5, offset: { x: 0, y: 4 }, step: 4, steps: 3 };
const SECTIONS = ['main', 'features', 'install', 'contributing', 'credits', 'community'];

test('the shipped config parses, with the avatar chosen and a layout for every banner slot', () => {
    const config = parseGithubConfig(REAL);
    const count = (asset) => config.layouts.filter((entry) => entry.asset === asset).length;
    assert.ok(count('avatar') >= 2);
    assert.equal(count('social'), 1, 'one social preview');
    assert.equal(count('banner'), 2 * SECTIONS.length, 'a banner for each section, in a light and a dark version');
    assert.deepEqual({ ...config.chosen }, { avatar: 'avatar-fill', social: 'social-grove' });

    const slots = Object.keys(config.final);
    assert.equal(slots.length, 2 + count('banner'), 'a slot for the avatar, the social preview and every banner');
    for (const section of SECTIONS) {
        for (const theme of ['light', 'dark']) {
            const slot = `banner-${section}-${theme}`;
            assert.ok(slots.includes(slot), `${slot} has a final file name`);
            assert.equal(layout(config, slot)?.asset, 'banner', `${slot} has the layout of its own id`);
        }
    }
});

test('a slot is an asset kind, and every banner slot is a banner', () => {
    assert.equal(slotAsset('avatar'), 'avatar');
    assert.equal(slotAsset('social'), 'social');
    assert.equal(slotAsset('banner-credits-dark'), 'banner');
});

test('the assets have the sizes and caps that GitHub and the plan ask for', () => {
    const { assets } = parseGithubConfig(REAL);
    assert.deepEqual([assets.avatar.width, assets.avatar.height], [500, 500]);
    assert.deepEqual([assets.social.width, assets.social.height], [1280, 640]);
    assert.equal(assets.banner.width, 2560);
    for (const asset of Object.values(assets)) {
        assert.ok(asset.maxBytes <= 1_000_000, 'under 1 MB, counting a megabyte as 1,000,000 bytes');
    }
});

test('every banner of the set is 2560x800, the main one and the section ones alike', () => {
    const config = parseGithubConfig(REAL);
    assert.deepEqual([config.assets.banner.width, config.assets.banner.height], [2560, 800]);
    for (const entry of config.layouts.filter(({ asset }) => asset === 'banner')) {
        assert.deepEqual([entry.width, entry.height], [2560, 800], entry.id);
    }
});

test('the scene of every banner and of the social preview is drawn at a whole step of 2 and pinned by its top edge, so that the layout sets the ground under it', () => {
    for (const entry of parseGithubConfig(REAL).layouts.filter(({ asset }) => asset !== 'avatar')) {
        const art = entry.elements.find(({ type }) => type === 'art');
        assert.equal(art.step, 2, entry.id);
        assert.ok(Number.isInteger(art.at.top) && !('centerY' in art.at), `${entry.id}: the top of the art is at ${art.at.top}`);
    }
});

test('no layout reuses the app art: every art source is a new picture with a name of its own', () => {
    const { sources } = parseGithubConfig(REAL);
    for (const path of Object.values(sources.art)) {
        assert.doesNotMatch(path, /hero-duo|welcome-both|splash/, path);
    }
    assert.deepEqual(Object.keys(sources.art).sort(), ['social-welcome', ...SECTIONS.map((section) => `banner-${section}`)].sort());
    const root = fileURLToPath(new URL('..', import.meta.url));
    for (const [name, path] of Object.entries(sources.art)) {
        assert.ok(existsSync(`${root}${path}`) || sources.placeholders[name], `${name} has its picture at ${path} or a stand-in until it lands`);
    }
    for (const name of Object.keys(sources.placeholders)) {
        assert.ok(Object.hasOwn(sources.art, name));
    }
});

test('every layout is made of the known kinds of element, and every art pixel is a whole step', () => {
    const known = ['plate', 'emblem', 'wordmark', 'title', 'subtitle', 'art', 'backdrop', 'frame', 'bar', 'icon'];
    for (const entry of parseGithubConfig(REAL).layouts) {
        for (const element of entry.elements) {
            assert.ok(known.includes(element.type));
            if (element.type === 'art') {
                assert.ok(Number.isInteger(element.step) && element.step >= 1);
            }
        }
        assert.ok(entry.elements.filter((element) => element.type === 'art').length <= 1, `${entry.id} has one scene`);
    }
});

test('the only text is the wordmark and the section titles, in a colour that reads against the background', () => {
    const config = parseGithubConfig(REAL);
    for (const entry of config.layouts.filter((candidate) => candidate.background !== null)) {
        for (const element of entry.elements.filter(({ type }) => type === 'wordmark' || type === 'title')) {
            assert.ok(contrastRatio(config.colours[element.colour], config.colours[entry.background]) >= 4.5, `${entry.id} ${element.type} contrast`);
        }
    }
});

test('a config that breaks a rule is refused with the rule named', () => {
    const wordmarkOf = (config) => layout(config, 'social-grove').elements.find(({ type }) => type === 'wordmark');
    const artOf = (config) => layout(config, 'social-grove').elements.find(({ type }) => type === 'art');
    const frameOf = (config) => layout(config, 'social-grove').elements.find(({ type }) => type === 'frame');
    const subtitleOf = (config) => layout(config, 'banner-main-light').elements.find(({ type }) => type === 'subtitle');
    const barOf = (config) => layout(config, 'banner-credits-dark').elements.find(({ type }) => type === 'bar');
    const edits = [
        [/unknown key "extra"/, (config) => { config.extra = 1; }],
        [/six hex digits/, (config) => { config.colours.lavender = 'purple'; }],
        [/needs "logo"/, (config) => { delete config.colours.logo; }],
        [/unique/, (config) => { config.layouts[1].id = config.layouts[0].id; }],
        [/layouts\[1\]\.id must be unique and made of lower case letters, digits and dashes, got true/, (config) => { config.layouts[1].id = true; }],
        [/not a size that the social asset may have/, (config) => { layout(config, 'social-grove').height = 600; }],
        [/Layout "social-grove" is 1281x640, which is not a size that the social asset may have/, (config) => { layout(config, 'social-grove').width = 1281; }],
        [/Layout "banner-credits-dark" is 2559x800, which is not a size that the banner asset may have/, (config) => { layout(config, 'banner-credits-dark').width = 2559; }],
        [/layouts must be a list of layouts/, (config) => { config.layouts = { 'social-grove': {} }; }],
        [/layouts\[3\] must be an object/, (config) => { config.layouts[3] = null; }],
        [/layouts\[2\] must be an object/, (config) => { config.layouts[2] = [layout(config, 'social-grove')]; }],
        [/layouts\[2\] has an unknown key "extra"/, (config) => { config.layouts[2].extra = 1; }],
        [/layouts\[1\]\.id must be unique and made of lower case letters, digits and dashes, got "Upper Case"/, (config) => { config.layouts[1].id = 'Upper Case'; }],
        [/Layout "social-grove" element 2 must be an object/, (config) => { layout(config, 'social-grove').elements[2] = null; }],
        [/Layout "social-grove" element 0 has an unknown key "extra"/, (config) => { layout(config, 'social-grove').elements[0].extra = 1; }],
        [/Layout "social-grove" element \d+ has an unknown key "height"\. Known keys: type, size, edge, at\./, (config) => { layout(config, 'social-grove').elements.find(({ type }) => type === 'plate').height = 3; }],
        [/element \d+\.colour "teal" is not one of the colours/, (config) => { layout(config, 'banner-credits-dark').elements.find(({ type }) => type === 'title').colour = 'teal'; }],
        [/not a size that the banner asset may have/, (config) => { layout(config, 'banner-credits-dark').height = 500; }],
        [/only an avatar may be transparent/, (config) => { layout(config, 'social-grove').background = null; }],
        [/exactly one of left, right, centerX/, (config) => { layout(config, 'social-grove').elements[0].at = { left: 1, centerX: 2, top: 3 }; }],
        [/step must be a whole number/, (config) => { artOf(config).step = 1.5; }],
        [/step must be a whole number/, (config) => { artOf(config).step = 0; }],
        [/source "dusk" is not one of the art sources/, (config) => { artOf(config).source = 'dusk'; }],
        [/must be one of plate, emblem, wordmark, title, subtitle, art, sparkles, moon, backdrop, frame, bar, icon/, (config) => { layout(config, 'social-grove').elements[1].type = 'text'; }],
        [/colour "teal" is not one of the colours/, (config) => { wordmarkOf(config).colour = 'teal'; }],
        [/line must be one of capCentre, baseline, got "middle"/, (config) => { wordmarkOf(config).line = 'middle'; }],
        [/lines read .* which is not the subtitle/, (config) => { subtitleOf(config).lines[2] = 'and modernized features!'; }],
        [/element \d+\.lines must be a list of lines of text/, (config) => { subtitleOf(config).lines = []; }],
        [/align must be one of left, centre/, (config) => { subtitleOf(config).align = 'right'; }],
        [/size must be a whole number/, (config) => { subtitleOf(config).size = 40.5; }],
        [/"Anything else" is not a section title/, (config) => { layout(config, 'banner-credits-dark').elements.find(({ type }) => type === 'title').title = 'Anything else'; }],
        [/maxWidth must be a whole number/, (config) => { layout(config, 'banner-credits-dark').elements.find(({ type }) => type === 'title').maxWidth = 100.5; }],
        [/edge needs an outline, a shadow, or both/, (config) => { wordmarkOf(config).edge = {}; }],
        [/edge\.outline\.width must be a whole number of 1 or more/, (config) => { wordmarkOf(config).edge = { outline: { colour: 'pale', width: 0 } }; }],
        [/edge\.shadow\.alpha must be above 0 and at most 1/, (config) => { wordmarkOf(config).edge = { shadow: { ...GOOD_SHADOW, alpha: 1.5 } }; }],
        [/edge\.shadow\.steps must be a whole number of 1 or more/, (config) => { wordmarkOf(config).edge = { shadow: { ...GOOD_SHADOW, steps: 0 } }; }],
        [/edge\.outline\.colour "teal" is not one of the colours/, (config) => { wordmarkOf(config).edge = { outline: { colour: 'teal', width: 2 } }; }],
        [/shadow\.strengths\.contact must be above 0 and at most 1/, (config) => { artOf(config).shadow.strengths.contact = 0; }],
        [/shadow\.strengths\.raised \(1\) must be below the strength of a contact \(1\)/, (config) => { artOf(config).shadow.strengths.raised = 1; }],
        [/shadow\.strengths\.footprint \(1\) must be below the strength of a contact \(1\)/, (config) => { artOf(config).shadow.strengths.footprint = 1; }],
        [/shadow\.strengths has an unknown key "floating"/, (config) => { artOf(config).shadow.strengths.floating = 0.2; }],
        [/shadow\.offset\.x must be a whole number/, (config) => { artOf(config).shadow.offset.x = 0.5; }],
        [/shadow has an unknown key "strength"/, (config) => { artOf(config).shadow.strength = 1; }],
        [/shadow\.tint "teal" is not one of the colours/, (config) => { artOf(config).shadow.tint = 'teal'; }],
        [/shadow\.bands must be a whole number of 1 or more/, (config) => { artOf(config).shadow.bands = 0; }],
        [/contacts\.social-welcome must be a list of where the scene touches the ground/, (config) => { config.contacts['social-welcome'] = []; }],
        [/contacts\.social-welcome\[0\]\.kind must be one of contact, footprint, raised, got "shadow"/, (config) => { config.contacts['social-welcome'][0].kind = 'shadow'; }],
        [/contacts\.social-welcome\[0\]\.x1 must be a whole number of 75 or more/, (config) => { config.contacts['social-welcome'][0].x1 = 5; }],
        [/contacts\.social-welcome\[0\]\.y must be a whole number of 0 or more/, (config) => { config.contacts['social-welcome'][0].y = -1; }],
        [/contacts\.social-welcome\[0\]\.strength must be above 0 and at most 1/, (config) => { config.contacts['social-welcome'][0].strength = 0; }],
        [/contacts\.social-welcome has no contact: something in the scene touches the ground/, (config) => { config.contacts['social-welcome'].forEach((entry) => { entry.kind = 'raised'; }); }],
        [/contacts has an unknown key "nowhere"/, (config) => { config.contacts.nowhere = [{ kind: 'contact', x0: 1, x1: 5, y: 9 }]; }],
        [/casts a contact shadow for the art "social-welcome", but contacts lists nothing for it/, (config) => { delete config.contacts['social-welcome']; }],
        [/casts a contact shadow for the art "banner-main", but contacts lists nothing for it/, (config) => { delete config.contacts['banner-main']; }],
        [/contacts\.social-welcome\[3\] is a raised with the strength 1, which is not below the strength of a contact \(1\)/, (config) => { config.contacts['social-welcome'][3].strength = 1; }],
        [/assets\.banner must be an object/, (config) => { config.assets.banner = null; }],
        [/assets\.banner needs a height, or a minHeight and a maxHeight/, (config) => { delete config.assets.banner.height; }],
        [/sources\.plate must be the path of an approved SVG/, (config) => { config.sources.plate = 1; }],
        [/sources\.emblem must be the path of an approved SVG/, (config) => { delete config.sources.emblem; }],
        [/sources\.art must map each art name/, (config) => { config.sources.art = {}; }],
        [/sources\.art must map each art name/, (config) => { config.sources.art['Banner Main'] = 'x.png'; }],
        [/has the asset "poster"; it must be one of avatar, social, banner/, (config) => { layout(config, 'social-grove').asset = 'poster'; }],
        [/background "teal" must be null or one of the colours/, (config) => { layout(config, 'social-grove').background = 'teal'; }],
        [/Layout "social-grove" needs a list of elements/, (config) => { layout(config, 'social-grove').elements = []; }],
        [/Layout "social-grove" note must be a string, got 3/, (config) => { layout(config, 'social-grove').note = 3; }],
        [/layers must be a list of at least two layers: a line and a fill/, (config) => { barOf(config).layers = [barOf(config).layers[0]]; }],
        [/\.bleed must be true or false/, (config) => { artOf(config).bleed = 'yes'; }],
        [/\.bleed must be true or false/, (config) => { layout(config, 'banner-credits-dark').elements[0].bleed = 1; }],
        [/\.mirror must be true or false/, (config) => { layout(config, 'banner-features-dark').elements[0].mirror = 'left'; }],
        [/unit is 3; decoration is built of blocks of 4 pixels or more/, (config) => { frameOf(config).unit = 3; }],
        [/unit is 4; decoration is built of blocks of 8 pixels or more/, (config) => { layout(config, 'banner-credits-dark').elements.at(-1).unit = 4; }],
        [/studs\.cells must be a whole number of 1 or more/, (config) => { barOf(config).studs.cells = 0; }],
        [/studs\.colour "teal" is not one of the colours/, (config) => { barOf(config).studs.colour = 'teal'; }],
        [/placeholders\.nothing is not an art source/, (config) => { config.sources.placeholders.nothing = { width: 100, height: 100 }; }],
        [/placeholders\.banner-install\.width must be a whole number of 24 or more/, (config) => { config.sources.placeholders['banner-install'] = { width: 10, height: 100 }; }],
        [/final\.banner-main is not a slot/, (config) => { config.final['banner-main'] = 'banner-main.png'; }],
        [/must be a PNG file name/, (config) => { config.final.avatar = '../avatar.png'; }],
        [/names two slots avatar\.png/, (config) => { config.final.social = 'avatar.png'; }],
        [/not a layout/, (config) => { config.chosen = { avatar: 'nothing' }; }],
        [/which is a social layout, not a avatar one/, (config) => { config.chosen = { avatar: 'social-grove' }; }],
    ];
    for (const [pattern, edit] of edits) {
        const config = clone();
        edit(config);
        assert.throws(() => parseGithubConfig(config), pattern);
    }
});

test('a config may leave out the sections that have nothing to say, and they are nothing: no icons, ornaments, backdrops, stand-ins, contacts, layouts or chosen layouts', () => {
    assert.throws(() => parseGithubConfig({}), /colours needs "lavender"/);
    assert.throws(() => parseGithubConfig({ colours: { lavender: '#b99bf2', logo: '#8b64aa' } }), /sources\.plate must be the path of an approved SVG/);
    const assets = Object.fromEntries(['avatar', 'social', 'banner'].map((asset) => [asset, { ...REAL.assets[asset] }]));
    const bare = parseGithubConfig({ colours: { lavender: '#b99bf2', logo: '#8b64aa' }, sources: { plate: 'p.svg', emblem: 'e.svg', art: { scene: 'scene.png' } }, assets });
    assert.deepEqual([bare.layouts.length, Object.keys(bare.contacts).length, Object.keys(bare.sources.placeholders).length, Object.keys(bare.sources.backdrops).length], [0, 0, 0, 0]);
    assert.equal(bare.chosen, null);
    const noNote = clone();
    delete layout(noNote, 'social-grove').note;
    assert.equal(parseGithubConfig(noNote).layouts.find(({ id }) => id === 'social-grove').note, '', 'a layout with no note has an empty one');
});

test('an asset may have a range of heights instead of one, and a layout of a height outside it is refused', () => {
    const ranged = clone();
    ranged.assets.banner = { width: 2560, minHeight: 700, maxHeight: 900, maxBytes: 1_000_000 };
    layout(ranged, 'banner-credits-dark').height = 850;
    assert.equal(parseGithubConfig(ranged).layouts.find(({ id }) => id === 'banner-credits-dark').height, 850);
    layout(ranged, 'banner-credits-dark').height = 1000;
    assert.throws(() => parseGithubConfig(ranged), /not a size that the banner asset may have/);
});

const DELETED = Symbol('deleted');
const MUTATIONS = {
    object: { nonsense: true },
    string: 'zzz',
    fraction: -0.5,
    boolean: true,
    null: null,
    zero: 0,
    'minus one': -1,
    deleted: DELETED,
};

/**
 * The places where the parser takes a mutation because it means something there: a path is checked when the file is read, a null stands
 * for a section, a size or a choice that is left out, a note or an id may be any text that is allowed of it, a key that is optional may be
 * left out, and 0 or -1 is a whole number that a position, an offset or an index may be.
 */
const TAKEN_AS_IT_IS = [
    { path: /^sources\.(plate|emblem|art\..+|backdrops\..+)$/, kinds: ['string'], why: 'a path, read when the sources are loaded' },
    { path: /^(sources\.placeholders|chosen)$/, kinds: ['null', 'deleted'], why: 'a section that is left out' },
    { path: /^colours\.ink$/, kinds: ['deleted'], why: 'a colour that no layout uses; one that a layout names is refused when it is left out' },
    { path: /^final\.banner-/, kinds: ['deleted'], why: 'the slots are the keys of final, so a banner slot that is left out is not a slot' },
    { path: /^chosen\.(avatar|social)$/, kinds: ['deleted'], why: 'a write run refuses a slot with no layout chosen, with a message of its own' },
    { path: /^contacts\..+\.\d+\.strength$/, kinds: ['deleted'], why: 'a contact has the strength of its kind unless it says otherwise' },
    { path: /^layouts\.\d+\.height$/, kinds: ['null', 'deleted'], why: 'null is the height of its asset' },
    { path: /^layouts\.\d+\.(note|id)$/, kinds: ['string'], why: 'text, and "zzz" is an id' },
    { path: /^layouts\.\d+\.note$/, kinds: ['deleted'], why: 'a layout needs no note' },
    { path: /^layouts\.\d+\.elements\.\d+\.(bleed|mirror|line|maxWidth|lift|edge|studs|shadow|strength)$/, kinds: ['deleted'], why: 'an optional key' },
    { path: /\.at\.(left|top|right|bottom|centerX|centerY|lineY)$/, kinds: ['zero', 'minus one'], why: 'a position may be 0 or before the edge' },
    { path: /\.(offset)\.(x|y)$/, kinds: ['zero', 'minus one'], why: 'an offset may be 0 or negative' },
    { path: /\.(inset|notch)$/, kinds: ['zero'], why: 'no inset and no notch are whole numbers of 0' },
    { path: /^contacts\..+\.\d+\.(x0|y)$/, kinds: ['zero'], why: 'column 0 and row 0 exist' },
];

test('every value of the shipped config is checked: a nonsense value, a number below a minimum, or a key that is left out, in any place of it, is refused unless it is a value that means something there', () => {
    const paths = [];
    const seenShapes = new Set();
    (function walk(value, path) {
        if (value === null || typeof value !== 'object') {
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            const next = [...path, key];
            // The layouts repeat each shape of element: one of each is enough.
            if (next[0] === 'layouts' && next.length >= 3) {
                const { asset, elements } = REAL.layouts[next[1]];
                const type = next[2] === 'elements' ? elements[next[3]]?.type : '';
                const shape = [asset, next[2], type, ...next.slice(next[2] === 'elements' ? 4 : 2).map((step) => (/^\d+$/.test(step) ? '#' : step))].join('|');
                if (seenShapes.has(shape)) {
                    continue;
                }
                seenShapes.add(shape);
            }
            paths.push(next);
            walk(child, next);
        }
    })(REAL, []);
    assert.ok(paths.length > 400, `${paths.length} places in the config`);
    const accepted = [];
    const reasonsUsed = new Set();
    for (const path of paths) {
        for (const [kind, mutation] of Object.entries(MUTATIONS)) {
            const config = clone();
            const holder = path.slice(0, -1).reduce((value, key) => value[key], config);
            const key = path.at(-1);
            if (mutation === DELETED ? Array.isArray(holder) : JSON.stringify(holder[key]) === JSON.stringify(mutation)) {
                continue;
            }
            if (mutation === DELETED) {
                delete holder[key];
            } else {
                holder[key] = mutation;
            }
            try {
                parseGithubConfig(config);
            } catch {
                continue;
            }
            const dotted = path.join('.');
            const reason = TAKEN_AS_IT_IS.find(({ path: allowed, kinds }) => allowed.test(dotted) && kinds.includes(kind));
            if (reason) {
                reasonsUsed.add(reason);
            } else {
                accepted.push(`${dotted} = ${kind}`);
            }
        }
    }
    assert.deepEqual(accepted, [], 'places where a mutation is taken');
    assert.deepEqual(TAKEN_AS_IT_IS.filter((reason) => !reasonsUsed.has(reason)).map(({ path }) => String(path)), [], 'every place that is let through still exists');
});
