import { mergeScriptCovs } from '@bcoe/v8-coverage';

/**
 * Compact Jest V8 coverage incrementally per source URL before Jest's built-in
 * `CoverageReporter` stores `testResult.v8Coverage`.
 *
 * Jest 29's `CoverageReporter` pushes every test file's raw `v8Coverage` array
 * into `_v8CoverageResults` and only merges them once all suites finish. Under
 * `--experimental-vm-modules`, suites that reset and re-import large frontend
 * modules (such as `public/script.js` and `public/scripts/sillybunny-tabs.js`)
 * emit hundreds of unmerged `ScriptCov` snapshots, exhausting the 4 GB main
 * process heap before the run completes.
 *
 * Registered in `jest.config.json`'s `reporters` list (which Jest dispatches
 * before its internal `CoverageReporter`), this reporter merges each URL's
 * coverage incrementally into the first-seen entry holder and trims duplicate
 * URLs out of subsequent `testResult.v8Coverage` arrays, keeping main-process
 * coverage memory bounded by the number of unique source files while producing
 * the exact same merged V8 coverage.
 */
export default class V8CoverageCompactReporter {
    constructor() {
        /** @type {Map<string, { codeTransformResult: any, result: import('@bcoe/v8-coverage').ScriptCov }>} */
        this._byUrl = new Map();
    }

    /**
     * @param {unknown} _test
     * @param {{ v8Coverage?: Array<{ codeTransformResult?: any, result?: import('@bcoe/v8-coverage').ScriptCov }> }} testResult
     */
    onTestFileResult(_test, testResult) {
        const entries = testResult?.v8Coverage;
        if (!Array.isArray(entries) || entries.length === 0) {
            return;
        }

        /** @type {Map<string, { codeTransformResult: any, results: import('@bcoe/v8-coverage').ScriptCov[] }>} */
        const grouped = new Map();
        const passthrough = [];

        for (const entry of entries) {
            const url = entry?.result?.url;
            if (!url) {
                passthrough.push(entry);
                continue;
            }
            let group = grouped.get(url);
            if (!group) {
                group = { codeTransformResult: entry.codeTransformResult, results: [] };
                grouped.set(url, group);
            } else if (!group.codeTransformResult && entry.codeTransformResult) {
                group.codeTransformResult = entry.codeTransformResult;
            }
            group.results.push(entry.result);
        }

        const firstSeenEntries = [...passthrough];

        for (const [url, group] of grouped.entries()) {
            const existing = this._byUrl.get(url);
            if (existing) {
                const merged = mergeScriptCovs([existing.result, ...group.results]);
                if (merged) {
                    existing.result = merged;
                }
                if (!existing.codeTransformResult && group.codeTransformResult) {
                    existing.codeTransformResult = group.codeTransformResult;
                }
            } else {
                const merged = group.results.length > 1
                    ? mergeScriptCovs(group.results)
                    : group.results[0];
                if (!merged) {
                    continue;
                }
                const holder = {
                    codeTransformResult: group.codeTransformResult,
                    result: merged,
                };
                this._byUrl.set(url, holder);
                firstSeenEntries.push(holder);
            }
        }

        testResult.v8Coverage = firstSeenEntries;
    }

    onRunComplete() {
        this._byUrl.clear();
    }
}
