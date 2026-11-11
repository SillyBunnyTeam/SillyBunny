#!/usr/bin/env node

// Turns the measurements of a parity run into the census files and, with --write, into the allow-list and its ratchet.
//
//   SB_PARITY_RECORD=1 SB_CENSUS_DIR=<dir> ~/bin/e2e -w 3 -c playwright.audit.config.js audit/surface-parity.e2e.js
//   node scripts/update-parity-allowlist.js --census <dir> [--write] [--partial] [--allow-increase]
//   node scripts/update-parity-allowlist.js --lower [--allow-increase]
//
// Without --write it only writes <family>.json, <family>.md and summary.md into <dir> (a relative <dir> is read from tests/,
// where the spec runs). With --write it replaces the temporary entries of every surface and viewport that the run measured,
// leaves every other entry alone, and lowers the per-family counts of tests/fixtures/parity-allowlist-counts.json. A count
// never rises unless --allow-increase is given. --write refuses a run that lacks measurements (a failed test, a narrowed run)
// unless --partial is given, and fails when a registered entry matches no outlier of a complete run.
// --lower needs no browser: it counts the temporary entries of the allow-list file and lowers the ratchet to those counts, for
// after an entry has been removed because its difference was fixed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWLIST_PATH, RATCHET_PATH, readAllowlist, readRatchet, writeAllowlist, writeRatchet } from '../tests/helpers/parity/allowlist.js';
import { buildFamilyCensus, buildSummary, sortMeasurements } from '../tests/helpers/parity/census.js';
import { entriesFromRows, mergeEntries, nextRatchet, temporaryCounts, unmatchedRegistered } from '../tests/helpers/parity/compare.js';
import { PARITY_FAMILIES, PARITY_VIEWPORTS, RULES } from '../tests/helpers/parity/index.js';
import { SURFACES } from '../tests/helpers/surfaces/index.js';
import { viewportsFor } from '../tests/helpers/surface-matrix.js';

const scriptFile = fileURLToPath(import.meta.url);
const testsDirectory = path.resolve(path.dirname(scriptFile), '../tests');

const USAGE = 'Usage: node scripts/update-parity-allowlist.js --census <dir> [--write] [--partial] [--allow-increase] | --lower [--allow-increase]';

function parseArguments(argumentsList) {
    const options = { census: null, write: false, partial: false, lower: false, allowIncrease: false, allowlist: ALLOWLIST_PATH, ratchet: RATCHET_PATH };
    for (let index = 0; index < argumentsList.length; index++) {
        const argument = argumentsList[index];
        if (argument === '--write') options.write = true;
        else if (argument === '--partial') options.partial = true;
        else if (argument === '--lower') options.lower = true;
        else if (argument === '--allow-increase') options.allowIncrease = true;
        else if (['--census', '--allowlist', '--ratchet'].includes(argument)) {
            const value = argumentsList[++index];
            if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
            options[argument.slice(2)] = path.resolve(argument === '--census' ? testsDirectory : process.cwd(), value);
        } else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!options.census && !options.lower) throw new Error(USAGE);
    return options;
}

/** Every surface and viewport that the spec measures: the surfaces of the families with rules, at the viewports they have, minus the skipped ones. */
function liveMeasurements() {
    const live = [];
    for (const surface of SURFACES.filter(candidate => PARITY_FAMILIES.includes(candidate.family))) {
        if (RULES[surface.family].skip?.[surface.id]) continue;
        for (const viewport of PARITY_VIEWPORTS.filter(id => viewportsFor(surface).includes(id))) live.push({ surface: surface.id, family: surface.family, viewport });
    }
    return live;
}

/** The measurements of the run that still belong to a surface of the registry, with the parts and rows that the rules still name. */
function readMeasurements(directory, live) {
    const rawDirectory = path.join(directory, 'raw');
    if (!fs.existsSync(rawDirectory)) throw new Error(`${rawDirectory} does not exist. Run the parity spec with SB_CENSUS_DIR=${directory} first.`);
    const liveKeys = new Set(live.map(item => `${item.surface}|${item.viewport}`));
    const kept = [];
    let ignored = 0;
    for (const name of fs.readdirSync(rawDirectory).filter(file => file.endsWith('.json'))) {
        const measurement = JSON.parse(fs.readFileSync(path.join(rawDirectory, name), 'utf8'));
        if (!liveKeys.has(`${measurement.surface}|${measurement.viewport}`)) {
            ignored++;
            continue;
        }
        const partIds = new Set(RULES[measurement.family].parts.map(part => part.id));
        kept.push({
            ...measurement,
            parts: measurement.parts.filter(state => partIds.has(state.part)),
            rows: measurement.rows.filter(row => partIds.has(row.part)),
        });
    }
    if (ignored) console.warn(`Ignored ${ignored} raw files of surfaces or viewports that the spec no longer measures.`);
    return sortMeasurements(kept);
}

function missingMeasurements(measurements, live) {
    const measured = new Set(measurements.map(measurement => `${measurement.surface}|${measurement.viewport}`));
    const families = new Set(measurements.map(measurement => measurement.family));
    return [
        ...PARITY_FAMILIES.filter(family => !families.has(family)).map(family => `the ${family} family`),
        ...live.filter(item => families.has(item.family) && !measured.has(`${item.surface}|${item.viewport}`)).map(item => `${item.surface}@${item.viewport}`),
    ];
}

function writeRatchetFor(options, entries) {
    const counts = temporaryCounts(entries, PARITY_FAMILIES);
    const previous = readRatchet(options.ratchet);
    const { counts: next, rises } = nextRatchet(previous?.temporary ?? null, counts, { allowIncrease: options.allowIncrease });
    if (rises.length > 0) {
        console.error(`The temporary entries would rise (${rises.join('; ')}). Nothing was written. Fix the new outliers, or add --allow-increase when the rise is intended.`);
        process.exitCode = 1;
        return false;
    }
    writeRatchet(next, options.ratchet);
    console.log(`Wrote ${path.relative(process.cwd(), options.ratchet)}: ${PARITY_FAMILIES.map(family => `${family} ${next[family]}`).join(', ')}`);
    return true;
}

function lower(options) {
    writeRatchetFor(options, readAllowlist(options.allowlist).entries);
}

function record(options) {
    const live = liveMeasurements();
    const measurements = readMeasurements(options.census, live);
    const rows = measurements.flatMap(measurement => measurement.rows);
    const cells = new Set(measurements.map(measurement => `${measurement.surface}|${measurement.viewport}`));
    const existing = fs.existsSync(options.allowlist) ? readAllowlist(options.allowlist).entries : [];
    const liveKeys = new Set(live.map(item => `${item.surface}|${item.viewport}`));
    const current = existing.filter(entry => entry.kind === 'registered' || entry.viewport === '*' || liveKeys.has(`${entry.surface}|${entry.viewport}`));
    const merged = mergeEntries(current, entriesFromRows(rows, current), cells);
    const counts = temporaryCounts(merged, PARITY_FAMILIES);

    const statsByFamily = {};
    for (const family of PARITY_FAMILIES.filter(name => measurements.some(measurement => measurement.family === name))) {
        const census = buildFamilyCensus({ rules: RULES[family], measurements: measurements.filter(measurement => measurement.family === family) });
        fs.writeFileSync(path.join(options.census, `${family}.json`), `${JSON.stringify(census.json, null, 2)}\n`);
        fs.writeFileSync(path.join(options.census, `${family}.md`), census.markdown);
        statsByFamily[family] = census.stats;
    }
    fs.writeFileSync(path.join(options.census, 'summary.md'), buildSummary(statsByFamily, counts));
    console.log(`Wrote the census of ${Object.keys(statsByFamily).join(', ')} (${measurements.length} measurements) to ${options.census}`);

    const missing = missingMeasurements(measurements, live);
    if (missing.length) console.warn(`${missing.length} measurements are missing (the test failed, or the run was narrowed): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', ...' : ''}`);

    if (!options.write) return;
    if (missing.length && !options.partial) {
        console.error('Nothing was written: the run lacks measurements, so entries of the missing cells would be kept as they are. Run the whole registry, or add --partial for a narrowed run.');
        process.exitCode = 1;
        return;
    }
    if (!missing.length) {
        const unmatched = unmatchedRegistered(current, rows);
        if (unmatched.length) {
            console.error(`Nothing was written: ${unmatched.length} registered entries match no outlier of this complete run. Remove them, or correct them:\n${unmatched.map(entry => `  ${entry.surface}@${entry.viewport} ${entry.part} ${entry.property} ${entry.value}`).join('\n')}`);
            process.exitCode = 1;
            return;
        }
    }
    if (!writeRatchetFor(options, merged)) return;
    writeAllowlist(merged, options.allowlist);
    console.log(`Wrote ${path.relative(process.cwd(), options.allowlist)} (${merged.length} entries)`);
}

function run() {
    const options = parseArguments(process.argv.slice(2));
    if (options.lower) lower(options);
    else record(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
    try {
        run();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
