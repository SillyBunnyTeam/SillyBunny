import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { main, parseArguments } from '../cli.js';
import { REPO_ROOT } from '../test-support/pictures.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const json = async (argv) => {
    const { output, exitCode } = await main(argv);
    return { ...JSON.parse(output), exitCode };
};

test('options are read per command, and a list is split', () => {
    assert.deepEqual(parseArguments(['prove', '--only', 'gs-reisen,about-tewi', '--pixels']), {
        command: 'prove',
        help: false,
        options: { only: ['gs-reisen', 'about-tewi'], pixels: true },
    });
    assert.equal(parseArguments(['--help']).help, true);
});

test('a usage error is JSON with exit 2', async () => {
    for (const argv of [[], ['paint'], ['derive', '--pixels'], ['prove', '--only'], ['check', '--colour', 'red'], ['check', 'prove']]) {
        const result = await json(argv);
        assert.deepEqual([result.ok, result.exitCode, result.problems[0].code], [false, 2, 'usage'], argv.join(' '));
    }
});

test('help is text with exit 0', async () => {
    const { output, exitCode } = await main(['--help']);

    assert.equal(exitCode, 0);
    assert.match(output, /^Usage: node scripts\/art\/cli\.js <command>/);
});

test('list names every asset with its masters and outputs', async () => {
    const result = await json(['list', '--root', REPO_ROOT]);

    assert.equal(result.exitCode, 0);
    const still = result.assets.find(({ id }) => id === 'gs-reisen');
    assert.deepEqual(still, {
        id: 'gs-reisen',
        type: 'still',
        key: 'home',
        ratio: '1',
        grid: [189, 372],
        masters: ['reisen/gs-reisen.png'],
        outputs: ['public/img/sillybunny/gs-reisen@native.webp'],
    });
});

test('the script prints one JSON document and exits with the code of its result', () => {
    const run = spawnSync(process.execPath, [CLI, 'prove', '--only', 'about-tewi'], { encoding: 'utf8' });

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout).problems, []);
});
