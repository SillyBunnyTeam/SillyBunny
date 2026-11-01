#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT_DIR } from './lib/cli.mjs';
import { parseSnapArgs } from './lib/snap-args.mjs';
import { compareSampling, measureMasters, parseBatch, runBatch, runSnap } from './lib/snap-run.mjs';
import { buildBodyCheckSheet } from './lib/snap-sheet.mjs';

const say = (line) => process.stdout.write(`${line}\n`);
const fixed = (value, digits = 2) => value.toFixed(digits);

const cell = (text, width) => String(text).padEnd(width);

function printMeasure({ rows, skipped }, figureHeight) {
    say([cell('picture', 24), cell('character', 10), cell('box px', 7), cell('head top', 9), cell('feet', 6), cell('head to feet (share of box)', 29), cell('detected cell (body art px)', 28), 'set: body px -> cell, box art px'].join(''));
    for (const row of rows) {
        const body = row.body.method === 'head' ? `${row.body.height} (${fixed(row.body.ratio * 100, 1)}%)` : 'not found';
        const set = row.set ? `${row.set.bodyHeight} -> ${fixed(row.set.cell, 3)}, ${fixed(row.set.boxArtHeight, 0)}` : '-';
        say([cell(row.id, 24), cell(row.character ?? '-', 10), cell(row.figure.height, 7), cell(row.body.headTop, 9), cell(row.body.feet, 6), cell(body, 29), cell(`${fixed(row.cell, 2)} (${fixed(row.bodyAtDetected, 0)}) strength ${fixed(Math.min(row.strengthAcross, row.strengthDown))}`, 28), set].join(''));
        if (row.target) {
            say(`${''.padEnd(24)}at ${figureHeight} art px (whole box): cell ${fixed(row.target.cell)} (${row.target.cellVersusDetected >= 0 ? '+' : ''}${fixed(row.target.cellVersusDetected * 100, 1)}% on detected), fit ${fixed(row.target.fit.across)}/${fixed(row.target.fit.down)}`);
        }
    }
    for (const row of rows) {
        for (const flag of row.flags) {
            say(`CHECK ${row.id}: ${flag}`);
        }
    }
    for (const { file, reason } of skipped) {
        say(`skipped ${file}: ${reason}`);
    }
}

function printBatch(results, dryRun) {
    say(`${dryRun ? 'DRY RUN, nothing written or logged: ' : ''}${results.length} pictures`);
    say('id                              character  cell     snapped size  head-feet art px  box art px  orphans  rings broken  rim+band set/measured  file');
    for (const { id, character, report, file } of results) {
        say(`${id.padEnd(31)} ${(character ?? '-').padEnd(9)} ${fixed(report.cell, 3)}   ${`${report.size.width}x${report.size.height}`.padEnd(12)}  ${String(report.body.height).padStart(16)}  ${String(report.figureHeight).padStart(10)}  ${String(report.orphans.length).padStart(7)}  ${String(report.rings?.broken ?? '-').padStart(12)}  ${(report.rings ? `${report.rings.rimWidth}+${report.rings.bandWidth} / ${report.rings.measured.rimWidth}+${report.rings.measured.bandWidth}` : '-').padEnd(20)}  ${file}`);
        for (const warning of report.warnings) {
            say(`  WARNING ${id}: ${warning}`);
        }
        for (const problem of report.body.problems) {
            say(`  CHECK ${id}: ${problem}`);
        }
    }
}

function printSnap(result) {
    const { report } = result;
    say(result.file);
    say(`character ${result.character ?? '-'}; head to feet ${report.body.method === 'head' ? `${report.body.height} art px (head top row ${report.body.headTop}, feet row ${report.body.feet})` : 'not found'}${report.targetBodyHeight === null ? '' : `, asked for ${report.targetBodyHeight}`}`);
    say(`pitch across ${fixed(report.pitchAcross)} (strength ${fixed(report.strengthAcross)}), down ${fixed(report.pitchDown)} (strength ${fixed(report.strengthDown)}); cell ${fixed(report.cell, 3)} (${report.cellSource}), offset ${fixed(report.offset.x)},${fixed(report.offset.y)}; fit at the cell ${fixed(report.fit.across)} across, ${fixed(report.fit.down)} down`);
    say(`snapped ${report.size.width}x${report.size.height} art pixels, figure ${report.figure ? `${report.figure.width}x${report.figure.height}` : 'none'}; sample ${report.sample}; ${report.colours === null ? 'no palette' : `${report.colours} colours`}, ${report.distinctColours} distinct; error against the master ${fixed(report.reprojectionError)}`);
    if (report.rings) {
        say(`rings: rim ${report.rings.rimWidth} + white band ${report.rings.bandWidth} art pixels (master ${report.rings.rimMaster === undefined ? 'unmeasured' : `${fixed(report.rings.rimMaster, 1)} + ${fixed(report.rings.bandMaster, 1)} px`}); ${report.rings.broken} ring pixels were broken by the snap and rebuilt; measured on the result: rim ${report.rings.measured.rimWidth} + band ${report.rings.measured.bandWidth}`);
        say(`ring check: rim in ${report.rings.rimShape.pieces} piece(s), white band in ${report.rings.bandShape.pieces}; ${report.rings.rimShape.isolated + report.rings.bandShape.isolated} isolated ring pixels`);
    } else {
        say('rings: not rebuilt (--no-ring-repair)');
    }
    const listed = report.orphans.slice(0, 12).map(({ x, y, kind, suggest }) => `${kind} ${x},${y} -> ${suggest}`).join('; ');
    say(`orphans: ${report.orphans.length} found, NOT changed${listed ? ` (${listed}${report.orphans.length > 12 ? '; ...' : ''})` : ''}; ${report.orphansExact} if every different colour counted`);
    say(report.fixes ? `fixes: ${report.fixes.edits} edits from ${report.fixes.file} changed ${report.fixes.changed} pixels` : 'fixes: none');
    for (const problem of report.body.problems) {
        say(`CHECK: ${problem}`);
    }
    for (const warning of report.warnings) {
        say(`WARNING: ${warning}`);
    }
    if (result.sheet) {
        say(`sheet: ${result.sheet}`);
    }
}

try {
    const request = parseSnapArgs(process.argv.slice(2));
    if (request.mode === 'measure') {
        const measured = await measureMasters({ rootDir: ROOT_DIR, approvedDir: resolve(ROOT_DIR, request.approved), figureHeight: request.figureHeight, only: request.only });
        printMeasure(measured, request.figureHeight);
        if (request.bodySheet) {
            const sheet = resolve(ROOT_DIR, request.bodySheet);
            mkdirSync(dirname(sheet), { recursive: true });
            writeFileSync(sheet, await buildBodyCheckSheet(measured.rows.map((row) => ({ label: `${row.id} ${row.body.height}${row.flags.length > 0 ? ' CHECK' : ''}`, raster: row.master, headTop: row.body.headTop, feet: row.body.feet, flagged: row.flags.length > 0 }))));
            say(`body check sheet: ${request.bodySheet}`);
        }
    } else if (request.mode === 'batch') {
        const batch = parseBatch(JSON.parse(readFileSync(resolve(ROOT_DIR, request.batchPath), 'utf8')));
        printBatch(await runBatch({ rootDir: ROOT_DIR, batch, stage: request.stage, outDir: request.outDir, sheetDir: request.sheetDir, dryRun: request.dryRun, sample: request.sample, now: () => new Date() }), request.dryRun);
    } else if (request.mode === 'compare') {
        const outcome = await compareSampling({ rootDir: ROOT_DIR, masterPath: resolve(request.inPath), id: request.id, options: request.options, character: request.character, detect: request.detect, colours: request.options.colours ?? 24, sheetPath: request.sheetPath });
        say(`${outcome.id}: cell ${fixed(outcome.cell, 3)}`);
        for (const result of outcome.results) {
            say(`  ${result.label.replace('\n', ': ')}${result.ringsBroken === null ? '' : `, ${result.ringsBroken} ring pixels rebuilt`}`);
        }
        if (outcome.sheet) {
            say(`sheet: ${outcome.sheet}`);
        }
    } else {
        printSnap(await runSnap({ rootDir: ROOT_DIR, masterPath: resolve(request.inPath), id: request.id, options: request.options, character: request.character, detect: request.detect, fixesPath: request.fixesPath, outPath: request.outPath, stage: request.stage, preview: request.preview, sheetPath: request.sheetPath, now: () => new Date() }));
    }
} catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
}
