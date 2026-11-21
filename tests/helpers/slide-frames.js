/**
 * Frame timing of a dialog page slide, measured in real time on the page.
 *
 * `installSlideProbe(page)` adds `window.__slideFrames(trigger)`. It runs `trigger`, then records the time of every
 * animation frame until no animation in the dialog host runs any more. It also records the long animation frames the
 * browser reports (with the scripts that filled them), and puts `slide-start` and `slide-end` marks on the user
 * timing track, so a trace of the same run can be cut at the slide.
 */

/** A frame whose interval is at least this long has dropped a frame at 60 Hz (16.7 ms), with half a frame of slack. */
export const LONG_FRAME_MS = 25;

export async function installSlideProbe(page) {
    await page.evaluate(() => {
        // The slide is over when no page is covered or leaving. Reading the classes forces no style or layout, which
        // `document.getAnimations()` would, on every frame of the run it measures. The pins and the height motion end
        // together with the slide, so they need no check of their own.
        const slideRunning = host => host.querySelector('.is-underlay, .is-leaving') !== null;
        window.__slideFrames = trigger => new Promise((resolve) => {
            const host = document.querySelector('dialog.sb-dialog-host:not([closing])');
            const longFrames = [];
            let observer = null;
            try {
                observer = new PerformanceObserver(list => longFrames.push(...list.getEntries()));
                observer.observe({ type: 'long-animation-frame', buffered: false });
            } catch {
                observer = null;
            }
            const stamps = [];
            const startedAt = performance.now();
            performance.mark('slide-start');
            trigger();
            let idleFrames = 0;
            let sawAnimation = false;
            const tick = (now) => {
                stamps.push(now);
                const running = slideRunning(host);
                sawAnimation ||= running;
                idleFrames = running ? 0 : idleFrames + 1;
                if ((sawAnimation && idleFrames >= 2) || now - startedAt > 4000) {
                    performance.mark('slide-end');
                    const records = observer ? observer.takeRecords() : [];
                    observer?.disconnect();
                    longFrames.push(...records);
                    resolve({
                        startedAt,
                        stamps,
                        longFrames: longFrames.map(entry => ({
                            start: entry.startTime,
                            duration: entry.duration,
                            blocking: entry.blockingDuration,
                            styleAndLayoutStart: entry.styleAndLayoutStart,
                            renderStart: entry.renderStart,
                            scripts: entry.scripts.map(script => ({
                                duration: script.duration,
                                type: script.invokerType,
                                invoker: script.invoker,
                                source: script.sourceURL?.split('/').slice(-2).join('/'),
                                fn: script.sourceFunctionName,
                                position: script.sourceCharPosition,
                                forcedStyleAndLayout: script.forcedStyleAndLayoutDuration,
                            })),
                        })),
                    });
                    return;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    });
}

/**
 * @param {{ startedAt: number, stamps: number[] }} run
 * @returns {{ frames: number, firstFrameMs: number, p50: number, p95: number, max: number, long: number, slideMs: number }}
 *   `firstFrameMs` is the time from the trigger to the first frame, which includes building the incoming page.
 *   The intervals are the times between consecutive frames while the slide runs.
 */
export function summarizeFrames({ startedAt, stamps }) {
    const intervals = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
    const sorted = [...intervals].sort((a, b) => a - b);
    const at = share => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
    return {
        frames: stamps.length,
        firstFrameMs: stamps[0] - startedAt,
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.at(-1) ?? 0,
        long: intervals.filter(interval => interval >= LONG_FRAME_MS).length,
        slideMs: stamps.at(-1) - startedAt,
    };
}
