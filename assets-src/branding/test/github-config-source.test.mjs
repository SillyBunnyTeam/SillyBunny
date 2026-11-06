import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGithubConfig, githubConfigText } from '../scripts/lib/github-config-source.mjs';
import { parseGithubConfig } from '../scripts/lib/github-config.mjs';
import { tempDir } from '../test-support/temp-dir.mjs';

const REAL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(REAL_ROOT, file), 'utf8');

test('the committed github-config.json is exactly what its source generates, so editing the JSON by hand is caught', async () => {
    const text = githubConfigText(await buildGithubConfig(REAL_ROOT));
    assert.equal(read('github-config.json'), text, 'run node scripts/github-config-emit.mjs after a change to the source or to a file beside it');
    assert.equal(githubConfigText(await buildGithubConfig(REAL_ROOT)), text, 'the same input is the same text');
});

test('the generated config is a config that parses, with the avatars of the parts file, the social preview and a light and a dark banner for each section', async () => {
    const generated = await buildGithubConfig(REAL_ROOT);
    const parsed = parseGithubConfig(JSON.parse(githubConfigText(generated)));
    const avatars = parsed.layouts.filter(({ asset }) => asset === 'avatar').length;
    assert.equal(parsed.layouts.length, avatars + 1 + 2 * Object.keys(generated.sources.art).filter((name) => name.startsWith('banner-')).length);
    assert.deepEqual(generated.contacts, JSON.parse(read('github-contacts.json')));
    assert.deepEqual(generated.layouts.slice(0, 3), JSON.parse(read('github-parts.json')).avatars);
    assert.deepEqual(generated.colours, JSON.parse(read('github-parts.json')).colours);
});

test('the check of the emit script passes on the committed config, and is the way to find out that the source and the file have parted', () => {
    const output = execFileSync(process.execPath, [join(REAL_ROOT, 'scripts/github-config-emit.mjs'), '--check'], { encoding: 'utf8' });
    assert.match(output, /is what the source generates/);
});

/** A package folder with the files that the source reads: the art for its sizes, and the files that are edited by hand. */
function packageCopy(edit) {
    const rootDir = tempDir('sb-github-config-source-');
    mkdirSync(join(rootDir, 'approved', 'pixel'), { recursive: true });
    const config = JSON.parse(read('github-config.json'));
    for (const path of Object.values(config.sources.art)) {
        copyFileSync(join(REAL_ROOT, path), join(rootDir, path));
    }
    writeFileSync(join(rootDir, 'github-config.json'), read('github-config.json'));
    const files = { 'github-parts.json': JSON.parse(read('github-parts.json')), 'github-contacts.json': JSON.parse(read('github-contacts.json')), 'github-backdrops.json': JSON.parse(read('github-backdrops.json')) };
    edit(files);
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(rootDir, name), JSON.stringify(content));
    }
    return rootDir;
}

const layoutById = (config, id) => config.layouts.find((layout) => layout.id === id);
const elementOf = (config, id, type) => layoutById(config, id).elements.find((element) => element.type === type);

test('a change in a file that is edited by hand reaches the config: a contact is in its contacts, the light of a plate in the offset of the shadows, and a colour in its colours', async () => {
    const same = await buildGithubConfig(packageCopy(() => {}));
    assert.equal(githubConfigText(same), read('github-config.json'), 'a copy of the files is the same config');
    const moved = await buildGithubConfig(packageCopy((files) => {
        files['github-contacts.json']['banner-credits'][0].x1 += 1;
        files['github-backdrops.json'].plates['mansion-day'].light.x = 2;
    }));
    assert.equal(moved.contacts['banner-credits'][0].x1, same.contacts['banner-credits'][0].x1 + 1);
    const offsetOf = (config, id) => elementOf(config, id, 'art').shadow.offset.x;
    assert.deepEqual([offsetOf(moved, 'banner-main-light'), offsetOf(moved, 'banner-features-light'), offsetOf(moved, 'banner-main-dark')], [2, -2, 0], 'a light of two blocks, mirrored on the left-hand banner, and none at night');
    assert.deepEqual([offsetOf(same, 'banner-main-light'), offsetOf(same, 'banner-features-light'), offsetOf(same, 'banner-main-dark')], [1, -1, 0], 'and the shipped light is one block');
    const recoloured = await buildGithubConfig(packageCopy((files) => { files['github-parts.json'].colours.plum = '#000000'; }));
    assert.equal(recoloured.colours.plum, '#000000');
    assert.equal(same.colours.plum, JSON.parse(read('github-parts.json')).colours.plum);
});

test('the step, the place and the bleed of a backdrop are the crop that github-backdrops.json holds, for the day plate and the night plate that takes its crops', async () => {
    const same = await buildGithubConfig(packageCopy(() => {}));
    const crops = JSON.parse(read('github-backdrops.json')).plates['mansion-day'].variants;
    for (const [id, variant] of [['banner-main-light', 'banner'], ['banner-features-dark', 'banner'], ['social-grove', 'social']]) {
        const { step, at, bleed } = elementOf(same, id, 'backdrop');
        assert.deepEqual({ step, at, bleed }, { step: crops[variant].step, at: crops[variant].at, bleed: crops[variant].bleed }, id);
    }
    const recropped = await buildGithubConfig(packageCopy((files) => {
        const banner = files['github-backdrops.json'].plates['mansion-day'].variants.banner;
        banner.step = 5;
        banner.at = { left: -7, top: -9 };
        delete banner.bleed;
    }));
    for (const id of ['banner-main-light', 'banner-community-dark']) {
        const backdrop = elementOf(recropped, id, 'backdrop');
        assert.deepEqual([backdrop.step, backdrop.at, 'bleed' in backdrop], [5, { left: -7, top: -9 }, false], `${id} follows the crop`);
    }
    assert.equal(elementOf(recropped, 'social-grove', 'backdrop').step, crops.social.step, 'and the social crop is not the banner crop');
});

test('a plate or a crop that a layout is set on but github-backdrops.json lacks is a message that names it, not a TypeError', async () => {
    const withoutSocial = packageCopy((files) => { delete files['github-backdrops.json'].plates['mansion-day'].variants.social; });
    await assert.rejects(buildGithubConfig(withoutSocial), /the plate "mansion-day" has no "social" crop, which the light social layouts are set on/);
    const withoutBanner = packageCopy((files) => { delete files['github-backdrops.json'].plates['mansion-day'].variants.banner; });
    await assert.rejects(buildGithubConfig(withoutBanner), /the plate "mansion-day" has no "banner" crop/, 'the night plate takes the crops of the day plate, so it lacks it too');
    const withoutNight = packageCopy((files) => { delete files['github-backdrops.json'].plates['mansion-night']; });
    await assert.rejects(buildGithubConfig(withoutNight), /github-backdrops\.json has no plate "mansion-night", which the dark layouts are set on/);
});

const EMIT = join(REAL_ROOT, 'scripts', 'github-config-emit.mjs');
const emit = (...args) => spawnSync(process.execPath, [EMIT, ...args], { encoding: 'utf8' });

test('--check exits 1 and says so when the committed config is not what the source generates, and writing makes it so', () => {
    const rootDir = packageCopy((files) => { files['github-contacts.json']['banner-credits'][0].x1 += 1; });
    const stale = readFileSync(join(rootDir, 'github-config.json'), 'utf8');
    const checked = emit('--check', '--root', rootDir);
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /is not what the source generates; run node scripts\/github-config-emit\.mjs/);
    assert.equal(readFileSync(join(rootDir, 'github-config.json'), 'utf8'), stale, 'a check writes nothing');

    const written = emit('--root', rootDir);
    assert.equal(written.status, 0);
    assert.notEqual(readFileSync(join(rootDir, 'github-config.json'), 'utf8'), stale);
    const after = emit('--check', '--root', rootDir);
    assert.deepEqual([after.status, after.stdout.includes('is what the source generates')], [0, true]);
});

test('the emit script prints its usage on stdout and exits 0 for --help, and a source it cannot read or a config that breaks a rule is a message and exit 1, never a stack, and writes nothing', () => {
    const help = emit('--help');
    assert.deepEqual([help.status, help.stderr], [0, '']);
    assert.match(help.stdout, /^Usage: node scripts\/github-config-emit\.mjs \[--check\]/);

    const broken = packageCopy(() => {});
    writeFileSync(join(broken, 'github-parts.json'), '{ not json');
    const unreadable = emit('--check', '--root', broken);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /JSON/);
    assert.doesNotMatch(unreadable.stderr, /\n\s+at /, 'a message and not a stack');

    const rootDir = packageCopy((files) => { files['github-contacts.json']['banner-credits'][0].kind = 'shadow'; });
    const before = readFileSync(join(rootDir, 'github-config.json'), 'utf8');
    const refused = emit('--root', rootDir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /contacts\.banner-credits\[0\]\.kind must be one of contact, footprint, raised/);
    assert.equal(readFileSync(join(rootDir, 'github-config.json'), 'utf8'), before, 'a config that breaks a rule is not written');
});
