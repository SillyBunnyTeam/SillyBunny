#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadPlaywright() {
    const candidates = [
        '@playwright/test',
        path.join(repoRoot, 'tests', 'node_modules', '@playwright', 'test'),
    ];

    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (error) {
            if (error?.code !== 'MODULE_NOT_FOUND') {
                throw error;
            }
        }
    }

    throw new Error('Unable to load @playwright/test. Run npm install in tests/ before running frontend performance measurements.');
}

const { chromium, devices } = loadPlaywright();
const outputDir = path.join(repoRoot, 'output', 'performance');
const baseUrl = process.env.SILLYBUNNY_PERF_URL || 'http://127.0.0.1:4444';
const outputPath = process.env.SILLYBUNNY_PERF_OUTPUT || path.join(outputDir, `frontend-${Date.now()}.json`);
const mobileProfile = devices['Pixel 5'];
const defaultProfileNames = Object.freeze(['mobile', 'desktop']);
const resourceTimingBufferSize = 1000;
export const LONG_CHAT_RENDER_MESSAGE_COUNT = 96;
export const LONG_CHAT_RENDER_VISIBLE_COUNT = 24;
export const LONG_CHAT_RENDER_FILLER_REPEAT = 36;
export const STREAM_RENDER_STEP_COUNT = 32;
export const STREAM_RENDER_FILLER_REPEAT = 48;
export const STREAM_RENDER_CODE_REPEAT = 12;

export const PERFORMANCE_PROFILES = Object.freeze({
    mobile: Object.freeze({
        name: 'mobile',
        label: 'Pixel 5',
        contextOptions: Object.freeze({ ...mobileProfile }),
    }),
    desktop: Object.freeze({
        name: 'desktop',
        label: 'Desktop 1366x900',
        contextOptions: Object.freeze({
            viewport: { width: 1366, height: 900 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
        }),
    }),
});

function getPathValue(object, metricPath) {
    return String(metricPath).split('.').reduce((current, key) => current?.[key], object);
}

export function parseProfileNames(value, profiles = PERFORMANCE_PROFILES) {
    if (!value) {
        return [...defaultProfileNames];
    }

    const requestedProfiles = [...new Set(String(value).split(',').map(name => name.trim()).filter(Boolean))];
    if (requestedProfiles.length === 0) {
        return [...defaultProfileNames];
    }

    const unknownProfiles = requestedProfiles.filter(name => !profiles[name]);
    if (unknownProfiles.length > 0) {
        throw new Error(`Unknown performance profile(s): ${unknownProfiles.join(', ')}`);
    }

    return requestedProfiles;
}

export function collectBudgetFailures(result, budget) {
    const maxBudgets = budget?.max ?? {};
    const failures = [];

    for (const [metricPath, maxValue] of Object.entries(maxBudgets)) {
        const actualValue = getPathValue(result, metricPath);
        if (typeof actualValue !== 'number') {
            failures.push({
                path: metricPath,
                expected: `number <= ${maxValue}`,
                actual: actualValue ?? null,
                reason: 'missing_metric',
            });
            continue;
        }

        if (actualValue > maxValue) {
            failures.push({
                path: metricPath,
                expected: `<= ${maxValue}`,
                actual: actualValue,
                reason: 'over_budget',
            });
        }
    }

    return failures;
}

export function summarizeRequests(requests) {
    const totals = {
        count: requests.length,
        js: 0,
        css: 0,
        font: 0,
        image: 0,
        other: 0,
    };

    for (const request of requests) {
        if (/\.m?js(?:\?|$)/i.test(request.url)) {
            totals.js += request.bytes;
        } else if (/\.css(?:\?|$)/i.test(request.url)) {
            totals.css += request.bytes;
        } else if (/\.(?:woff2?|ttf)(?:\?|$)/i.test(request.url)) {
            totals.font += request.bytes;
        } else if (/\.(?:png|jpe?g|webp|gif|svg|ico)(?:\?|$)/i.test(request.url)) {
            totals.image += request.bytes;
        } else {
            totals.other += request.bytes;
        }
    }

    return totals;
}

export function summarizeRequestByteFields(requests) {
    return {
        transfer: summarizeRequests(requests),
        encoded: summarizeRequests(requests.map(request => ({
            ...request,
            bytes: request.encodedBodySize || 0,
        }))),
        decoded: summarizeRequests(requests.map(request => ({
            ...request,
            bytes: request.decodedBodySize || 0,
        }))),
        zeroTransferCount: requests.filter(request => (request.bytes || 0) === 0).length,
        zeroTransferWithEncodedBodyCount: requests.filter(request => (request.bytes || 0) === 0 && (request.encodedBodySize || 0) > 0).length,
    };
}

export function createStreamingRenderFixture({
    stepCount = STREAM_RENDER_STEP_COUNT,
    fillerRepeat = STREAM_RENDER_FILLER_REPEAT,
    codeRepeat = STREAM_RENDER_CODE_REPEAT,
} = {}) {
    const codeLines = Array.from({ length: codeRepeat }, (_, index) => `console.log('stream fixture ${index}');`).join('\n');
    const fullText = [
        'Streaming performance fixture.',
        `${'reasoning detail '.repeat(fillerRepeat)}`,
        '```js',
        codeLines,
        '```',
        `${'final response text '.repeat(fillerRepeat)}`,
    ].join('\n');
    const steps = [];

    for (let index = 1; index <= stepCount; index++) {
        const end = Math.ceil((fullText.length * index) / stepCount);
        steps.push(fullText.slice(0, end));
    }

    return {
        stepCount,
        fillerRepeat,
        codeRepeat,
        fullText,
        steps,
    };
}

export function createLongChatRenderFixture({
    messageCount = LONG_CHAT_RENDER_MESSAGE_COUNT,
    visibleCount = LONG_CHAT_RENDER_VISIBLE_COUNT,
    fillerRepeat = LONG_CHAT_RENDER_FILLER_REPEAT,
} = {}) {
    const messages = [];

    for (let index = 0; index < messageCount; index++) {
        const isUser = index % 2 === 0;
        const baseText = `performance synthetic message ${index}`;
        messages.push({
            name: isUser ? 'Scroll Tester' : 'Bunny Guide',
            is_user: isUser,
            is_system: false,
            send_date: new Date(Date.UTC(2024, 0, 1, 0, index)).toISOString(),
            mes: `${baseText}\n${'long chat filler '.repeat(fillerRepeat)}`,
            extra: {},
        });
    }

    return {
        messageCount,
        visibleCount,
        fillerRepeat,
        messages,
    };
}

export async function measureLongChatRender(page, fixture = createLongChatRenderFixture()) {
    const renderResult = await page.evaluate(async ({ messages, messageCount, visibleCount, fillerRepeat }) => {
        const browserGlobal = globalThis;
        const context = browserGlobal.SillyTavern?.getContext?.();
        const chatElement = browserGlobal.document.querySelector('#chat');

        if (!context || !(chatElement instanceof browserGlobal.HTMLElement) || typeof context.printMessages !== 'function') {
            return {
                available: false,
                reason: 'chat-context-unavailable',
            };
        }

        context.powerUserSettings.auto_scroll_chat_to_bottom = true;
        context.powerUserSettings.chat_truncation = visibleCount;
        context.chat.length = 0;
        chatElement.replaceChildren();
        context.chat.push(...messages);

        const start = browserGlobal.performance.now();
        await context.printMessages();
        await new Promise(resolve => browserGlobal.requestAnimationFrame(() => browserGlobal.requestAnimationFrame(resolve)));
        const durationMs = browserGlobal.performance.now() - start;
        const renderedMessages = Array.from(chatElement.querySelectorAll('.mes[mesid]'));

        return {
            available: true,
            durationMs,
            messageCount: context.chat.length,
            visibleCount,
            fillerRepeat,
            renderedCount: renderedMessages.length,
            firstRenderedMesId: renderedMessages.at(0)?.getAttribute('mesid') ?? null,
            lastRenderedMesId: renderedMessages.at(-1)?.getAttribute('mesid') ?? null,
            bottomDelta: chatElement.scrollHeight - chatElement.clientHeight - chatElement.scrollTop,
        };
    }, fixture);

    return {
        fixture: {
            messageCount: fixture.messageCount,
            visibleCount: fixture.visibleCount,
            fillerRepeat: fixture.fillerRepeat,
        },
        ...renderResult,
    };
}

export async function measureStreamingRender(page, fixture = createStreamingRenderFixture()) {
    const renderResult = await page.evaluate(async ({ steps, stepCount, fillerRepeat, codeRepeat }) => {
        const browserGlobal = globalThis;
        const context = browserGlobal.SillyTavern?.getContext?.();
        const chatElement = browserGlobal.document.querySelector('#chat');

        if (!context || !Array.isArray(context.chat) || typeof context.messageFormatting !== 'function') {
            return {
                available: false,
                reason: 'chat-formatting-unavailable',
            };
        }

        const previousChat = context.chat.slice();
        const host = browserGlobal.document.createElement('div');
        const target = browserGlobal.document.createElement('div');
        const messageId = 1;
        const message = {
            name: 'Bunny Guide',
            is_user: false,
            is_system: false,
            mes: '',
            extra: {},
        };

        host.className = 'mes';
        host.setAttribute('mesid', String(messageId));
        target.className = 'mes_text';
        host.appendChild(target);

        try {
            context.chat.length = 0;
            context.chat.push({
                name: 'Scroll Tester',
                is_user: true,
                is_system: false,
                mes: 'seed message',
                extra: {},
            }, message);
            (chatElement ?? browserGlobal.document.body).appendChild(host);

            let formatTotalMs = 0;
            let writeTotalMs = 0;
            let maxStepMs = 0;
            const start = browserGlobal.performance.now();

            for (const step of steps) {
                message.mes = step;
                const stepStart = browserGlobal.performance.now();
                const formatStart = browserGlobal.performance.now();
                const formatted = context.messageFormatting(step, message.name, message.is_system, message.is_user, messageId, {}, false);
                formatTotalMs += browserGlobal.performance.now() - formatStart;

                const writeStart = browserGlobal.performance.now();
                target.innerHTML = formatted;
                writeTotalMs += browserGlobal.performance.now() - writeStart;
                maxStepMs = Math.max(maxStepMs, browserGlobal.performance.now() - stepStart);
            }

            let plainPreview = {
                available: false,
                reason: 'plain-preview-module-unavailable',
            };
            try {
                const { formatPlainTextStreamingPreview } = await import('/scripts/mobile-streaming.js');
                const previewTarget = browserGlobal.document.createElement('div');
                previewTarget.className = 'mes_text';
                host.appendChild(previewTarget);

                let previewFormatTotalMs = 0;
                let previewWriteTotalMs = 0;
                let previewMaxStepMs = 0;
                const previewStart = browserGlobal.performance.now();

                for (const step of steps) {
                    const stepStart = browserGlobal.performance.now();
                    const formatStart = browserGlobal.performance.now();
                    const formatted = formatPlainTextStreamingPreview(step);
                    previewFormatTotalMs += browserGlobal.performance.now() - formatStart;

                    const writeStart = browserGlobal.performance.now();
                    previewTarget.innerHTML = formatted;
                    previewWriteTotalMs += browserGlobal.performance.now() - writeStart;
                    previewMaxStepMs = Math.max(previewMaxStepMs, browserGlobal.performance.now() - stepStart);
                }

                plainPreview = {
                    available: true,
                    totalMs: browserGlobal.performance.now() - previewStart,
                    formatTotalMs: previewFormatTotalMs,
                    writeTotalMs: previewWriteTotalMs,
                    averageStepMs: (browserGlobal.performance.now() - previewStart) / Math.max(1, steps.length),
                    maxStepMs: previewMaxStepMs,
                    finalHtmlBytes: new TextEncoder().encode(previewTarget.innerHTML).length,
                    domNodeCount: previewTarget.querySelectorAll('*').length,
                };
            } catch (error) {
                plainPreview = {
                    available: false,
                    reason: error?.message ?? String(error),
                };
            }

            await new Promise(resolve => browserGlobal.requestAnimationFrame(() => browserGlobal.requestAnimationFrame(resolve)));
            const totalMs = browserGlobal.performance.now() - start;

            return {
                available: true,
                totalMs,
                formatTotalMs,
                writeTotalMs,
                averageStepMs: totalMs / Math.max(1, steps.length),
                maxStepMs,
                stepCount: steps.length,
                fillerRepeat,
                codeRepeat,
                finalHtmlBytes: new TextEncoder().encode(target.innerHTML).length,
                domNodeCount: target.querySelectorAll('*').length,
                codeBlockCount: target.querySelectorAll('pre code').length,
                plainPreview,
            };
        } finally {
            host.remove();
            context.chat.splice(0, context.chat.length, ...previousChat);
        }
    }, fixture);

    return {
        fixture: {
            stepCount: fixture.stepCount,
            fillerRepeat: fixture.fillerRepeat,
            codeRepeat: fixture.codeRepeat,
        },
        ...renderResult,
    };
}

async function captureInstrumentationSnapshot(page) {
    return await page.evaluate(() => {
        const metrics = globalThis.__sillyBunnyPerfInstrumentation;
        return metrics ? JSON.parse(JSON.stringify(metrics)) : null;
    }).catch(() => null);
}

async function measurePage(page) {
    const metrics = await page.evaluate(() => {
        const browserGlobal = globalThis;
        const navigation = browserGlobal.performance.getEntriesByType('navigation')[0];
        const paint = Object.fromEntries(browserGlobal.performance.getEntriesByType('paint').map(entry => [entry.name, entry.startTime]));
        const resources = browserGlobal.performance.getEntriesByType('resource');
        const longTasks = browserGlobal.performance.getEntriesByType('longtask');

        return {
            navigation: navigation ? {
                domContentLoaded: navigation.domContentLoadedEventEnd,
                load: navigation.loadEventEnd,
                transferSize: navigation.transferSize,
                encodedBodySize: navigation.encodedBodySize,
                decodedBodySize: navigation.decodedBodySize,
            } : null,
            paint,
            longTasks: {
                count: longTasks.length,
                totalDuration: longTasks.reduce((total, task) => total + task.duration, 0),
                longest: longTasks.reduce((max, task) => Math.max(max, task.duration), 0),
            },
            resourceCount: resources.length,
            heap: browserGlobal.performance.memory ? {
                usedJSHeapSize: browserGlobal.performance.memory.usedJSHeapSize,
                totalJSHeapSize: browserGlobal.performance.memory.totalJSHeapSize,
            } : null,
        };
    });
    const instrumentationAtReady = await captureInstrumentationSnapshot(page);

    const scrollFps = await page.evaluate(async () => {
        const browserGlobal = globalThis;
        const browserDocument = browserGlobal.document;
        const scroller = browserDocument.getElementById('chat') || browserDocument.scrollingElement;
        if (!scroller) {
            return null;
        }

        const frameTimes = [];
        let previous = browserGlobal.performance.now();
        const start = previous;

        return new Promise(resolve => {
            function step(now) {
                frameTimes.push(now - previous);
                previous = now;
                scroller.scrollTop += 24;

                if (now - start >= 1000) {
                    const averageFrame = frameTimes.reduce((total, frame) => total + frame, 0) / Math.max(1, frameTimes.length);
                    resolve({
                        frames: frameTimes.length,
                        averageFrame,
                        estimatedFps: averageFrame ? 1000 / averageFrame : 0,
                    });
                    return;
                }

                browserGlobal.requestAnimationFrame(step);
            }

            browserGlobal.requestAnimationFrame(step);
        });
    });

    const chatRender = {
        longChat: await measureLongChatRender(page),
        streaming: await measureStreamingRender(page),
    };
    const instrumentationAfterSynthetic = await captureInstrumentationSnapshot(page);

    return {
        ...metrics,
        instrumentation: {
            ready: instrumentationAtReady,
            afterSynthetic: instrumentationAfterSynthetic,
        },
        scrollFps,
        chatRender,
    };
}

async function waitForAppReady(page) {
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60000 });
    await page.waitForFunction(() => {
        const browserGlobal = globalThis;
        return typeof browserGlobal.SillyTavern?.getContext === 'function'
            && browserGlobal.document.getElementById('chat') instanceof browserGlobal.HTMLElement;
    }, { timeout: 60000 });
}

function installResourceTimingBuffer(size) {
    if (typeof globalThis.performance?.setResourceTimingBufferSize === 'function') {
        globalThis.performance.setResourceTimingBufferSize(size);
    }
}

function installPerformanceInstrumentation() {
    const browserGlobal = globalThis;
    if (browserGlobal.__sillyBunnyPerfInstrumentation) {
        return;
    }

    const metrics = {
        eventListeners: {
            total: 0,
            scroll: 0,
            resize: 0,
            touchmove: 0,
            wheel: 0,
        },
        visualViewportListeners: {
            total: 0,
            resize: 0,
            scroll: 0,
        },
        layoutReads: {
            getBoundingClientRect: 0,
        },
        selectors: {
            querySelector: 0,
            querySelectorAll: 0,
        },
        observers: {
            mutationCreated: 0,
            resizeCreated: 0,
        },
    };

    Object.defineProperty(browserGlobal, '__sillyBunnyPerfInstrumentation', {
        configurable: false,
        enumerable: false,
        value: metrics,
    });

    const countKnownKey = (target, key) => {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
            target[key]++;
        }
    };

    const originalAddEventListener = browserGlobal.EventTarget?.prototype?.addEventListener;
    if (typeof originalAddEventListener === 'function') {
        browserGlobal.EventTarget.prototype.addEventListener = function (type) {
            const normalizedType = String(type);
            metrics.eventListeners.total++;
            countKnownKey(metrics.eventListeners, normalizedType);
            if (this === browserGlobal.visualViewport) {
                metrics.visualViewportListeners.total++;
                countKnownKey(metrics.visualViewportListeners, normalizedType);
            }

            return originalAddEventListener.apply(this, arguments);
        };
    }

    const originalGetBoundingClientRect = browserGlobal.Element?.prototype?.getBoundingClientRect;
    if (typeof originalGetBoundingClientRect === 'function') {
        browserGlobal.Element.prototype.getBoundingClientRect = function () {
            metrics.layoutReads.getBoundingClientRect++;
            return originalGetBoundingClientRect.apply(this, arguments);
        };
    }

    for (const prototype of [browserGlobal.Document?.prototype, browserGlobal.Element?.prototype].filter(Boolean)) {
        const originalQuerySelector = prototype.querySelector;
        if (typeof originalQuerySelector === 'function') {
            prototype.querySelector = function () {
                metrics.selectors.querySelector++;
                return originalQuerySelector.apply(this, arguments);
            };
        }

        const originalQuerySelectorAll = prototype.querySelectorAll;
        if (typeof originalQuerySelectorAll === 'function') {
            prototype.querySelectorAll = function () {
                metrics.selectors.querySelectorAll++;
                return originalQuerySelectorAll.apply(this, arguments);
            };
        }
    }

    if (typeof browserGlobal.MutationObserver === 'function') {
        browserGlobal.MutationObserver = new Proxy(browserGlobal.MutationObserver, {
            construct(target, args, newTarget) {
                metrics.observers.mutationCreated++;
                return Reflect.construct(target, args, newTarget);
            },
        });
    }

    if (typeof browserGlobal.ResizeObserver === 'function') {
        browserGlobal.ResizeObserver = new Proxy(browserGlobal.ResizeObserver, {
            construct(target, args, newTarget) {
                metrics.observers.resizeCreated++;
                return Reflect.construct(target, args, newTarget);
            },
        });
    }
}

async function collectResourceTimings(page) {
    return await page.evaluate(() => {
        const resources = performance.getEntriesByType('resource');
        return resources.map(entry => ({
            url: entry.name,
            bytes: entry.transferSize || 0,
            encodedBodySize: entry.encodedBodySize || 0,
            decodedBodySize: entry.decodedBodySize || 0,
            initiatorType: entry.initiatorType || '',
        }));
    });
}

async function measureNavigation(page, action) {
    await page.evaluate(() => globalThis.performance.clearResourceTimings()).catch(() => {});
    await action();
    await waitForAppReady(page);
    const resources = await collectResourceTimings(page);
    const metrics = await measurePage(page);
    const documentRequest = metrics.navigation ? [{
        url: page.url(),
        bytes: metrics.navigation.transferSize || 0,
        encodedBodySize: metrics.navigation.encodedBodySize || 0,
        decodedBodySize: metrics.navigation.decodedBodySize || 0,
    }] : [];
    const requestEntries = [...documentRequest, ...resources];

    return {
        metrics,
        requests: summarizeRequests(requestEntries),
        requestBytes: summarizeRequestByteFields(requestEntries),
    };
}

function serializeError(error) {
    return {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
    };
}

async function measureProfile(browser, profile, { url, serviceWorkers, instrumentation }) {
    const context = await browser.newContext({
        ...profile.contextOptions,
        serviceWorkers,
    });

    await context.addInitScript(installResourceTimingBuffer, resourceTimingBufferSize);

    if (instrumentation) {
        await context.addInitScript(installPerformanceInstrumentation);
    }

    const page = await context.newPage();

    try {
        const cold = await measureNavigation(page, () => page.goto(url, { waitUntil: 'networkidle' }));
        const warm = await measureNavigation(page, () => page.reload({ waitUntil: 'networkidle' }));

        return {
            name: profile.name,
            label: profile.label,
            viewport: profile.contextOptions.viewport ?? null,
            cold,
            warm,
        };
    } finally {
        await context.close();
    }
}

async function readBudgetFile(budgetPath) {
    if (!budgetPath) {
        return null;
    }

    return JSON.parse(await fs.readFile(budgetPath, 'utf8'));
}

export async function run({
    url = baseUrl,
    output = outputPath,
    profileNames = parseProfileNames(process.env.SILLYBUNNY_PERF_PROFILES || process.env.SILLYBUNNY_PERF_PROFILE),
    serviceWorkers = process.env.SILLYBUNNY_PERF_SERVICE_WORKERS === 'allow' ? 'allow' : 'block',
    instrumentation = ['1', 'true', 'on'].includes(String(process.env.SILLYBUNNY_PERF_INSTRUMENTATION).toLowerCase()),
    budgetPath = process.env.SILLYBUNNY_PERF_BUDGET || '',
} = {}) {
    await fs.mkdir(path.dirname(output), { recursive: true });

    const browser = await chromium.launch();
    const profiles = {};
    let hasProfileError = false;

    try {
        for (const profileName of profileNames) {
            const profile = PERFORMANCE_PROFILES[profileName];
            console.error(`Measuring ${profile.label}...`);
            try {
                profiles[profileName] = await measureProfile(browser, profile, { url, serviceWorkers, instrumentation });
            } catch (error) {
                hasProfileError = true;
                profiles[profileName] = {
                    name: profile.name,
                    label: profile.label,
                    viewport: profile.contextOptions.viewport ?? null,
                    error: serializeError(error),
                };
                console.error(`Measurement failed for ${profile.label}: ${error?.message ?? error}`);
            }
        }
    } finally {
        await browser.close();
    }

    const result = {
        url,
        measuredAt: new Date().toISOString(),
        serviceWorkers,
        instrumentation,
        profiles,
    };

    if (hasProfileError) {
        result.error = 'One or more performance profiles failed.';
        process.exitCode = 1;
    }

    const budget = await readBudgetFile(budgetPath);
    if (budget) {
        const failures = collectBudgetFailures(result, budget);
        result.budget = {
            path: budgetPath,
            failures,
        };

        if (failures.length > 0) {
            console.error(`Performance budget failed with ${failures.length} violation(s).`);
            for (const failure of failures) {
                console.error(`${failure.path}: expected ${failure.expected}, actual ${failure.actual}`);
            }
            process.exitCode = 1;
        }
    }

    await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));

    return result;
}

function isDirectRun() {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
    run().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
