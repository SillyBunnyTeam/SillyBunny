/* eslint-disable playwright/no-standalone-expect -- Jest contracts for plain functions. */
import { describe, expect, jest, test } from '@jest/globals';

import { BOOT_MARK_NAMES, initBootMarks, readBootMarks } from '../../public/scripts/sillybunny-boot-marks.js';

/** A `performance` that keeps the marks it is given, in the order they were made. */
function createFakePerformance(entries = []) {
    const marks = [...entries];
    return {
        marks,
        mark: jest.fn((name) => { marks.push({ name, startTime: 100 + marks.length }); }),
        getEntriesByName: name => marks.filter(entry => entry.name === name),
    };
}

describe('the boot marks', () => {
    test('are the four moments of a start, in the order they happen', () => {
        expect(BOOT_MARK_NAMES).toEqual(['sb-boot-inline', 'sb-boot-init-start', 'sb-boot-dismiss', 'sb-app-ready']);
    });

    test('are read in boot order, whatever order they were made in', () => {
        const performanceLike = createFakePerformance([
            { name: 'sb-app-ready', startTime: 900 },
            { name: 'sb-boot-inline', startTime: 12.5 },
            { name: 'unrelated', startTime: 1 },
        ]);

        expect(readBootMarks(performanceLike)).toEqual([
            { name: 'sb-boot-inline', startTime: 12.5 },
            { name: 'sb-app-ready', startTime: 900 },
        ]);
    });

    test('leave out a mark that was not made, so a missing one is not a zero', () => {
        expect(readBootMarks(createFakePerformance())).toEqual([]);
    });

    test('read the first of a mark that was made twice, because the boot is the first start', () => {
        const performanceLike = createFakePerformance([
            { name: 'sb-boot-dismiss', startTime: 500 },
            { name: 'sb-boot-dismiss', startTime: 800 },
        ]);

        expect(readBootMarks(performanceLike)).toEqual([{ name: 'sb-boot-dismiss', startTime: 500 }]);
    });

    test('read as nothing where the browser has no performance marks', () => {
        expect(readBootMarks(undefined)).toEqual([]);
        expect(readBootMarks({})).toEqual([]);
    });
});

describe('the app ready mark', () => {
    function createEvents() {
        const listeners = [];
        return {
            eventSource: { on: jest.fn((name, listener) => listeners.push([name, listener])) },
            eventTypes: { APP_READY: 'app_ready' },
            fire: name => listeners.filter(([listened]) => listened === name).forEach(([, listener]) => listener()),
        };
    }

    test('is made when the app is ready, and not before', () => {
        const performanceLike = createFakePerformance();
        const events = createEvents();

        initBootMarks({ ...events, performanceLike });
        expect(performanceLike.mark).not.toHaveBeenCalled();
        events.fire('app_ready');

        expect(performanceLike.mark).toHaveBeenCalledTimes(1);
        expect(performanceLike.mark).toHaveBeenCalledWith('sb-app-ready');
    });

    test('is made once, even if the event fires again', () => {
        const performanceLike = createFakePerformance();
        const events = createEvents();

        initBootMarks({ ...events, performanceLike });
        events.fire('app_ready');
        events.fire('app_ready');

        expect(performanceLike.mark).toHaveBeenCalledTimes(1);
    });

    test('is skipped without a failure where the browser cannot make marks', () => {
        const events = createEvents();

        initBootMarks({ ...events, performanceLike: {} });

        expect(() => events.fire('app_ready')).not.toThrow();
    });
});
