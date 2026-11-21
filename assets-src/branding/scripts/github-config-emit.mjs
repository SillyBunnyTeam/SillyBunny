#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildGithubConfig, githubConfigText } from './lib/github-config-source.mjs';
import { parseGithubConfig } from './lib/github-config.mjs';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage: node scripts/github-config-emit.mjs [--check] [--root <package folder>]

Writes github-config.json from its source, scripts/lib/github-config-source.mjs, with the parts, the contacts and the light of the plates that
are edited by hand in github-parts.json, github-contacts.json and github-backdrops.json. The config that is written is parsed first, and a
config that breaks a rule is not written.

  --check   write nothing; exit 1 when the committed github-config.json is not what the source generates
  --root    the package folder to read and write (assets-src/branding by default)
`;
const say = (line) => process.stdout.write(`${line}\n`);

async function main() {
    const { values } = parseArgs({ options: { check: { type: 'boolean' }, root: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
        process.stdout.write(USAGE);
        return;
    }
    const rootDir = values.root ? resolve(values.root) : PACKAGE_DIR;
    const configPath = join(rootDir, 'github-config.json');
    const text = githubConfigText(await buildGithubConfig(rootDir));
    parseGithubConfig(JSON.parse(text));
    if (!values.check) {
        writeFileSync(configPath, text);
        say(`wrote ${configPath}`);
        return;
    }
    const same = readFileSync(configPath, 'utf8') === text;
    say(same ? 'github-config.json is what the source generates.' : 'github-config.json is not what the source generates; run node scripts/github-config-emit.mjs.');
    process.exitCode = same ? 0 : 1;
}

try {
    await main();
} catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
}
