import { describe, expect, test } from '@jest/globals';

import {
    collectDevicePerfSnapshot,
    DEFAULT_ANDROID_PERF_BUDGETS,
    evaluateAndroidPerfBudgets,
    formatPerfSummaryMarkdown,
    parseDiskUsageMb,
    parseGfxinfoFramestats,
    parseHealthyAfterMs,
    parseMeminfoSummary,
} from './android-smoke/perf-metrics.js';

const SAMPLE_GFXINFO_API36 = `
Total frames rendered: 120
Janky frames: 6 (5.00%)
Janky frames (legacy): 3 (2.50%)
50th percentile: 17ms
90th percentile: 18ms
95th percentile: 19ms
99th percentile: 97ms
Number Missed Vsync: 1
Number Slow UI thread: 3
---PROFILEDATA---
Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,FrameDeadline,FrameInterval,FrameStartTime,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted,SwapBuffersCompleted,DisplayPresentTime,CommandSubmissionCompleted
0,101,1000000000,1000000000,0,1000100000,1000200000,1000300000,1000500000,1016666667,16666667,1000100000,1004100000,1004500000,1005000000,1006500000,1010000000,0,0,1010000000,1010000000,0,1007000000
0,102,1016666667,1016666667,0,1016766667,1016866667,1016966667,1017066667,1033333334,16666667,1016766667,1034766667,1035000000,1035500000,1037000000,1040000000,0,0,1040000000,1040000000,0,1038000000
---PROFILEDATA---
`;

describe('Android smoke performance collector and budget evaluator', () => {
    test('parses API 36 dumpsys gfxinfo framestats dynamically by header column name', () => {
        const parsed = parseGfxinfoFramestats(SAMPLE_GFXINFO_API36);
        expect(parsed).toEqual(expect.objectContaining({
            totalFrames: 120,
            jankyFrames: 6,
            jankyPct: 5,
            jankyLegacyPct: 2.5,
            p50Ms: 17,
            p90Ms: 18,
            p95Ms: 19,
            p99Ms: 97,
            missedVsync: 1,
            slowUi: 3,
            framestatsCount: 2,
            over16Cpu: 1,
            over33Cpu: 0,
        }));
        expect(parsed.avgCpuMs).toBeCloseTo(13, 1);
        expect(parsed.maxCpuMs).toBeCloseTo(20, 1);
    });

    test('parses dumpsys meminfo, du -sk disk usage, and server.log healthy markers', () => {
        const mem = parseMeminfoSummary([
            '  Native Heap    24576    24576',
            '  Dalvik Heap     8192     8192',
            '         Native Heap:    24576',
            '           TOTAL PSS:   163840            TOTAL RSS:   327680',
            '    Death Recipients:        3             WebViews:        1',
        ].join('\n'));
        expect(mem).toEqual({
            totalPssMb: 160,
            totalRssMb: 320,
            nativeHeapMb: 24,
            dalvikHeapMb: 8,
            webViews: 1,
        });

        const disk = parseDiskUsageMb('681984\tfiles\n62464\tfiles/SillyBunny/.git\n');
        expect(disk).toEqual({
            files: 666,
            'files/SillyBunny/.git': 61,
        });

        const healthy = parseHealthyAfterMs([
            '[sillybunny-android] healthy afterMs=37695',
            '[sillybunny-android] healthy afterMs=3288',
        ].join('\n'));
        expect(healthy).toEqual({
            count: 2,
            firstMs: 37695,
            lastMs: 3288,
            minMs: 3288,
            maxMs: 37695,
            samples: [37695, 3288],
        });
    });

    test('evaluates Android performance budgets and flags only exceeded ceilings', () => {
        const healthySnapshot = {
            diskMb: { files: 666, 'files/SillyBunny/.git': 61 },
            meminfo: { totalPssMb: 170 },
            gfxinfo: { totalFrames: 120, jankyPct: 5.4, maxCpuMs: 95.6 },
            serverHealthy: { count: 2, firstMs: 37_695, lastMs: 3_400 },
        };
        expect(evaluateAndroidPerfBudgets(healthySnapshot, DEFAULT_ANDROID_PERF_BUDGETS)).toEqual({
            ok: true,
            violations: [],
        });

        const regressedSnapshot = {
            diskMb: { files: 1028, 'files/SillyBunny/.git': 163 },
            meminfo: { totalPssMb: 410 },
            gfxinfo: { totalFrames: 120, jankyPct: 30, maxCpuMs: 472.4 },
            serverHealthy: { count: 2, firstMs: 91_000, lastMs: 14_500 },
        };
        const evaluation = evaluateAndroidPerfBudgets(regressedSnapshot, DEFAULT_ANDROID_PERF_BUDGETS);
        expect(evaluation.ok).toBe(false);
        expect(evaluation.violations.map(v => v.metric)).toEqual([
            'diskMb.files',
            'diskMb.files/SillyBunny/.git',
            'meminfo.totalPssMb',
            'gfxinfo.jankyPct',
            'gfxinfo.maxCpuMs',
            'serverHealthy.warmMs',
        ]);

        const markdown = formatPerfSummaryMarkdown(regressedSnapshot, evaluation).join('\n');
        expect(markdown).toContain('### Android Performance Snapshot');
        expect(markdown).toContain('Performance budget violations:');
    });

    test('collects a non-fatal device snapshot through the injected adb client', async () => {
        const adb = {
            shellText: async (args) => {
                if (args[0] === 'dumpsys' && args[1] === 'gfxinfo') return SAMPLE_GFXINFO_API36;
                if (args[0] === 'dumpsys' && args[1] === 'meminfo') return 'TOTAL PSS: 163840 TOTAL RSS: 327680';
                if (args[0] === 'run-as' && String(args[4]).startsWith('du')) return '681984\tfiles\n62464\tfiles/SillyBunny/.git\n';
                if (args[0] === 'run-as' && String(args[4]).startsWith('cat')) return '[sillybunny-android] healthy afterMs=3500\n';
                throw new Error('unexpected command');
            },
        };

        const snapshot = await collectDevicePerfSnapshot({
            adb,
            pkg: 'io.github.sillybunnyteam.sillybunny.debug',
            records: [
                { id: 1, key: 'first-run', durationMs: 62_800 },
                { id: 2, key: 'legacy-ms', ms: 1_250 },
            ],
        });
        expect(snapshot.stepDurationsMs).toEqual({
            'step-1-first-run': 62_800,
            'step-2-legacy-ms': 1_250,
        });
        expect(snapshot.diskMb.files).toBe(666);
        expect(snapshot.meminfo.totalPssMb).toBe(160);
        expect(snapshot.gfxinfo.jankyPct).toBe(5);
        expect(snapshot.serverHealthy.lastMs).toBe(3500);
    });
});
