#!/usr/bin/env node

/**
 * Writes `summary.json` and `summary.md` of a capture run from the results that its tests left in the capture directory.
 * The spec writes them itself when its last test ends; run this after a run that was cut short, or after shards that wrote
 * to one directory. Give it the variables of the run (SURFACE_FAMILY, CAPTURE_SET, SB_VISUAL_BASELINE_DIR and the rest):
 *   SB_CAPTURE_DIR=<dir> SB_VISUAL_BASELINE_DIR=<dir> node audit/capture-summary.js
 * `SB_CAPTURE_DIR` is required here, because the default directory belongs to a Playwright run.
 */

import { writeSummary } from '../helpers/capture-files.js';
import { exitCodeOf, planRun } from '../helpers/capture-plan.js';

const dir = process.env.SB_CAPTURE_DIR?.trim();
if (!dir) {
    console.error('Set SB_CAPTURE_DIR to the capture directory of the run.');
    process.exit(2);
}
const run = planRun();
const summary = writeSummary({ dir, planned: run.plannedKeys });
console.log(`${dir}/summary.md written: ${JSON.stringify(summary.totals)}`);
process.exit(exitCodeOf(summary));
