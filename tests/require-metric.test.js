import { describe, expect, test } from '@jest/globals';

import { diffCdpPerfMetrics, readCdpPerfMetrics } from '../scripts/measure-frontend-performance.js';
import { requireMetric } from './helpers/require-metric.js';

const CDP_METRIC_NAMES = ['RecalcStyleCount', 'RecalcStyleDuration', 'LayoutCount', 'LayoutDuration', 'ScriptDuration'];

/** A CDP session that answers `Performance.getMetrics` with one reading per call, minus the named metrics. */
function createCdpSession(readings, { omit = [] } = {}) {
    let call = 0;
    return {
        send: async (method) => {
            if (method !== 'Performance.getMetrics') {
                return {};
            }
            const reading = readings[call++];
            return {
                metrics: CDP_METRIC_NAMES
                    .filter(name => !omit.includes(name))
                    .map(name => ({ name, value: reading })),
            };
        },
    };
}

async function measureWith(cdpSession) {
    const before = await readCdpPerfMetrics(cdpSession);
    const after = await readCdpPerfMetrics(cdpSession);
    return { cdp: diffCdpPerfMetrics(before, after) };
}

describe('requireMetric', () => {
    test('returns a number that is present, including zero', () => {
        expect(requireMetric({ cdp: { layoutCount: 0 }, mutationCallbacks: 4 }, 'cdp.layoutCount', 'idle')).toBe(0);
        expect(requireMetric({ cdp: { layoutCount: 0 }, mutationCallbacks: 4 }, 'mutationCallbacks', 'idle')).toBe(4);
    });

    test.each([
        ['an absent measurement', undefined],
        ['a measurement without CDP data', { cdp: null }],
        ['a metric that was not reported', { cdp: {} }],
        ['a metric that is undefined', { cdp: { recalcStyleCount: undefined } }],
        ['a metric that is NaN', { cdp: { recalcStyleCount: NaN } }],
        ['a metric that is a string', { cdp: { recalcStyleCount: '3' } }],
    ])('throws an error that names the metric for %s', (_, measurement) => {
        expect(() => requireMetric(measurement, 'cdp.recalcStyleCount', 'idle behind Settings'))
            .toThrow('idle behind Settings: metric "cdp.recalcStyleCount" is missing');
    });
});

describe('CDP metrics that the browser does not report', () => {
    test('are read as a failure to measure, not as a count of zero', async () => {
        const measurement = await measureWith(createCdpSession([10, 14], { omit: ['RecalcStyleCount'] }));

        expect(measurement.cdp.recalcStyleCount).toBeNull();
        expect(measurement.cdp.layoutCount).toBe(4);
        expect(() => requireMetric(measurement, 'cdp.recalcStyleCount', 'streaming')).toThrow('cdp.recalcStyleCount');
    });

    test('keep their value when every metric is reported', async () => {
        const measurement = await measureWith(createCdpSession([10, 14]));

        expect(requireMetric(measurement, 'cdp.recalcStyleCount', 'streaming')).toBe(4);
        expect(requireMetric(measurement, 'cdp.layoutCount', 'streaming')).toBe(4);
    });

    test('make a missing CDP session fail the same way', async () => {
        const measurement = await measureWith(null);

        expect(measurement.cdp).toBeNull();
        expect(() => requireMetric(measurement, 'cdp.layoutCount', 'streaming')).toThrow('cdp.layoutCount');
    });
});
