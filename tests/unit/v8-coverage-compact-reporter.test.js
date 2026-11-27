import { mergeProcessCovs } from '@bcoe/v8-coverage';
import { describe, expect, test } from '@jest/globals';

import V8CoverageCompactReporter from '../util/v8-coverage-compact-reporter.js';

function makeScriptCov(url, scriptId, ranges) {
    return {
        scriptId: String(scriptId),
        url,
        functions: [
            {
                functionName: '',
                ranges,
                isBlockCoverage: true,
            },
        ],
    };
}

describe('V8CoverageCompactReporter', () => {
    test('merges repeated URLs incrementally in-place and matches batch mergeProcessCovs output', () => {
        const scriptA = 'file:///repo/public/script.js';
        const scriptB = 'file:///repo/public/scripts/sillybunny-tabs.js';

        const suite1Raw = [
            { codeTransformResult: { code: 'a' }, result: makeScriptCov(scriptA, 1, [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 10, endOffset: 40, count: 0 }]) },
            { codeTransformResult: { code: 'a' }, result: makeScriptCov(scriptA, 2, [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 10, endOffset: 40, count: 2 }, { startOffset: 50, endOffset: 80, count: 0 }]) },
        ];
        const suite2Raw = [
            { codeTransformResult: { code: 'a' }, result: makeScriptCov(scriptA, 3, [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 50, endOffset: 80, count: 3 }]) },
            { codeTransformResult: { code: 'b' }, result: makeScriptCov(scriptB, 4, [{ startOffset: 0, endOffset: 50, count: 1 }]) },
        ];
        const suite3Raw = [
            { codeTransformResult: { code: 'b' }, result: makeScriptCov(scriptB, 5, [{ startOffset: 0, endOffset: 50, count: 4 }]) },
        ];

        // Simulate uncompacted Jest CoverageReporter accumulation.
        const expectedMerged = mergeProcessCovs([
            { result: suite1Raw.map(e => e.result) },
            { result: suite2Raw.map(e => e.result) },
            { result: suite3Raw.map(e => e.result) },
        ]);

        // Simulate V8CoverageCompactReporter running before CoverageReporter on the same testResult objects.
        const reporter = new V8CoverageCompactReporter();
        const simulatedCoverageReporterStore = [];

        for (const raw of [suite1Raw, suite2Raw, suite3Raw]) {
            const testResult = { v8Coverage: raw.map(e => ({ ...e })) };
            reporter.onTestFileResult(null, testResult);
            simulatedCoverageReporterStore.push(testResult.v8Coverage);
        }

        // Only first-seen entries remain across all suites.
        expect(simulatedCoverageReporterStore[0]).toHaveLength(1);
        expect(simulatedCoverageReporterStore[1]).toHaveLength(1);
        expect(simulatedCoverageReporterStore[2]).toHaveLength(0);

        const actualMerged = mergeProcessCovs(
            simulatedCoverageReporterStore.map(cov => ({ result: cov.map(r => r.result) })),
        );

        expect(actualMerged).toEqual(expectedMerged);
        reporter.onRunComplete();
    });

    test('is a no-op when testResult has no v8Coverage', () => {
        const reporter = new V8CoverageCompactReporter();
        const result = {};
        reporter.onTestFileResult(null, result);
        expect(result).toEqual({});
    });
});
