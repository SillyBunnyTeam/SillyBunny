import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scriptSource = new URL('../scripts/bump-agent-template-versions.js', import.meta.url);
const templatesRel = 'public/scripts/extensions/in-chat-agents/templates';

let repo;

function git(...args) {
    return execFileSync('git', [
        '-c', 'user.name=Test',
        '-c', 'user.email=test@example.invalid',
        '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null',
        ...args,
    ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeJson(relativePath, value) {
    fs.writeFileSync(path.join(repo, relativePath), `${JSON.stringify(value, null, 4)}\n`);
}

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(repo, relativePath), 'utf8'));
}

function writeTemplate({ version = 1, prompt = 'one', indexVersion = version, indexPrompt = prompt } = {}) {
    writeJson(`${templatesRel}/tpl-a.json`, { id: 'tpl-a', version, prompt });
    writeJson(`${templatesRel}/index.json`, [{ id: 'tpl-a', version: indexVersion, prompt: indexPrompt }]);
}

function commit(message) {
    git('add', '-A');
    git('commit', '-q', '-m', message);
}

function runScript(...args) {
    return spawnSync(process.execPath, ['scripts/bump-agent-template-versions.js', ...args], { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-template-versions-'));
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.mkdirSync(path.join(repo, templatesRel), { recursive: true });
    fs.copyFileSync(scriptSource, path.join(repo, 'scripts', 'bump-agent-template-versions.js'));
    writeJson('package.json', { type: 'module' });
    git('init', '-q');
    writeTemplate();
    commit('base');
});

afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('bump-agent-template-versions --check', () => {
    test('fails when a template file changes without a version bump', () => {
        writeTemplate({ prompt: 'two', indexPrompt: 'one' });
        commit('change content');

        const result = runScript('--check', '--base', 'HEAD~1');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${templatesRel}/tpl-a.json changed but stays at v1; it needs at least v2.`);
        expect(result.stderr).toContain('npm run agents:bump-template-versions -- --base HEAD~1');
    });

    test('fails when an index.json entry changes without a version bump', () => {
        writeTemplate({ prompt: 'one', indexPrompt: 'two' });
        commit('change index entry');

        const result = runScript('--check', '--base', 'HEAD~1', '--head', 'HEAD');
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${templatesRel}/index.json entry tpl-a changed but stays at v1`);
    });

    test('passes when changed content carries a version bump', () => {
        writeTemplate({ version: 2, prompt: 'two' });
        commit('change and bump');

        const result = runScript('--check', '--base', 'HEAD~1');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Bundled agent template versions are up to date.');
    });

    test('ignores version-only changes and new templates', () => {
        writeTemplate({ version: 3 });
        writeJson(`${templatesRel}/tpl-b.json`, { id: 'tpl-b', version: 1, prompt: 'new' });
        commit('bump only and add template');

        expect(runScript('--check', '--base', 'HEAD~1').status).toBe(0);
    });

    test('rejects a missing base and an unknown ref', () => {
        expect(runScript('--check').stderr).toContain('--check needs --base <ref>.');
        expect(runScript('--check', '--base', 'no-such-ref').stderr).toContain('--base no-such-ref is not a commit.');
        expect(runScript('--head', 'HEAD').stderr).toContain('--head works only with --check.');
    });
});

describe('bump-agent-template-versions --base', () => {
    test('bumps committed changes against the base commit', () => {
        writeTemplate({ prompt: 'two' });
        commit('change content');

        const result = runScript('--base', 'HEAD~1');
        expect(result.status).toBe(0);
        expect(readJson(`${templatesRel}/tpl-a.json`).version).toBe(2);
        expect(readJson(`${templatesRel}/index.json`)[0].version).toBe(2);
    });

    test('keeps the default comparison against HEAD', () => {
        writeTemplate({ prompt: 'two' });
        commit('change content');

        expect(runScript().stdout).toContain('No bundled agent template content changes need version bumps.');
        expect(readJson(`${templatesRel}/tpl-a.json`).version).toBe(1);
    });
});
