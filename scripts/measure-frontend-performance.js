#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BOOT_MARK_NAMES } from '../public/scripts/sillybunny-boot-marks.js';

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
export const STREAM_REASONING_STEP_COUNT = 24;
export const STREAM_REASONING_REPEAT = 320;
export const STREAM_REASONING_RESPONSE_REPEAT = 24;
export const IDLE_SAMPLE_DURATION_MS = 1500;
const LONG_CHAT_SCROLL_SETTLE_MS = 2500;

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

export function parseCpuThrottleRate(value = 1) {
    const rate = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(rate) || rate < 1) {
        throw new Error('CPU throttle rate must be a finite number greater than or equal to 1.');
    }
    return rate;
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
            name: isUser ? 'Scroll Tester' : 'Seraphina',
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

export function createStreamingReasoningFixture({
    stepCount = STREAM_REASONING_STEP_COUNT,
    reasoningRepeat = STREAM_REASONING_REPEAT,
    responseRepeat = STREAM_REASONING_RESPONSE_REPEAT,
} = {}) {
    const reasoningText = `${'chain of thought reasoning segment '.repeat(reasoningRepeat)}`.trim();
    const fullResponse = [
        'Streaming response after completed reasoning.',
        `${'assistant narrative token stream '.repeat(responseRepeat)}`.trim(),
    ].join('\n\n');
    const steps = [];

    for (let index = 1; index <= stepCount; index++) {
        const end = Math.ceil((fullResponse.length * index) / stepCount);
        steps.push(fullResponse.slice(0, end));
    }

    return {
        stepCount,
        reasoningRepeat,
        responseRepeat,
        reasoningText,
        fullResponse,
        steps,
    };
}

export async function readCdpPerfMetrics(cdpSession) {
    if (!cdpSession || typeof cdpSession.send !== 'function') {
        return null;
    }

    try {
        await cdpSession.send('Performance.enable');
        const response = await cdpSession.send('Performance.getMetrics');
        const map = Object.fromEntries((response?.metrics ?? []).map(metric => [metric.name, metric.value]));
        return {
            RecalcStyleCount: Number(map.RecalcStyleCount ?? 0),
            RecalcStyleDuration: Number(map.RecalcStyleDuration ?? 0),
            LayoutCount: Number(map.LayoutCount ?? 0),
            LayoutDuration: Number(map.LayoutDuration ?? 0),
            ScriptDuration: Number(map.ScriptDuration ?? 0),
        };
    } catch {
        return null;
    }
}

export function diffCdpPerfMetrics(before, after) {
    if (!before || !after) {
        return null;
    }

    return {
        recalcStyleCount: Math.max(0, after.RecalcStyleCount - before.RecalcStyleCount),
        recalcStyleMs: +Math.max(0, (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000).toFixed(2),
        layoutCount: Math.max(0, after.LayoutCount - before.LayoutCount),
        layoutMs: +Math.max(0, (after.LayoutDuration - before.LayoutDuration) * 1000).toFixed(2),
        scriptMs: +Math.max(0, (after.ScriptDuration - before.ScriptDuration) * 1000).toFixed(2),
    };
}

export async function measureIdleActivity(page, { cdpSession = null, durationMs = IDLE_SAMPLE_DURATION_MS } = {}) {
    const before = await readCdpPerfMetrics(cdpSession);
    const sample = await page.evaluate(async (sampleMs) => {
        const browserGlobal = globalThis;
        const root = browserGlobal.document?.documentElement;
        if (!root || typeof browserGlobal.MutationObserver !== 'function') {
            return { available: false, reason: 'dom-unavailable' };
        }

        let mutationRecords = 0;
        let mutationCallbacks = 0;
        const observer = new browserGlobal.MutationObserver((records) => {
            mutationCallbacks++;
            mutationRecords += records.length;
        });
        observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });

        try {
            await new Promise(resolve => browserGlobal.setTimeout(resolve, sampleMs));
            const pending = observer.takeRecords();
            if (pending.length > 0) {
                mutationCallbacks++;
                mutationRecords += pending.length;
            }
        } finally {
            observer.disconnect();
        }

        const animations = typeof browserGlobal.document.getAnimations === 'function'
            ? browserGlobal.document.getAnimations().filter(anim => anim.playState === 'running')
            : [];

        return {
            available: true,
            durationMs: sampleMs,
            mutationRecords,
            mutationCallbacks,
            runningAnimations: animations.length,
        };
    }, durationMs);
    const after = await readCdpPerfMetrics(cdpSession);

    return {
        ...sample,
        cdp: diffCdpPerfMetrics(before, after),
    };
}

export async function measureStreamingWithReasoning(page, fixture = createStreamingReasoningFixture(), { cdpSession = null } = {}) {
    const before = await readCdpPerfMetrics(cdpSession);
    const result = await page.evaluate(async ({ steps, reasoningText, stepCount }) => {
        const browserGlobal = globalThis;
        const context = browserGlobal.SillyTavern?.getContext?.();
        const chatElement = browserGlobal.document?.querySelector('#chat');

        if (!context || !Array.isArray(context.chat) || typeof context.messageFormatting !== 'function') {
            return { available: false, reason: 'chat-formatting-unavailable' };
        }

        const previousChat = context.chat.slice();
        const host = browserGlobal.document.createElement('div');
        const reasoningDetails = browserGlobal.document.createElement('details');
        const reasoningSummary = browserGlobal.document.createElement('summary');
        const reasoningContent = browserGlobal.document.createElement('div');
        const target = browserGlobal.document.createElement('div');
        const messageId = 1;
        const message = {
            name: 'Seraphina',
            is_user: false,
            is_system: false,
            mes: '',
            extra: { reasoning: reasoningText, reasoning_duration: 1200 },
        };

        host.className = 'mes';
        host.setAttribute('mesid', String(messageId));
        reasoningDetails.className = 'mes_reasoning_details';
        reasoningSummary.className = 'mes_reasoning_header';
        reasoningSummary.textContent = 'Thought for 1s';
        reasoningContent.className = 'mes_reasoning';
        reasoningContent.textContent = reasoningText;
        reasoningDetails.append(reasoningSummary, reasoningContent);
        target.className = 'mes_text';
        host.append(reasoningDetails, target);

        let getBoundingClientRectCount = 0;
        let querySelectorAllCount = 0;
        const originalGbcr = browserGlobal.Element?.prototype?.getBoundingClientRect;
        const originalDocQsa = browserGlobal.Document?.prototype?.querySelectorAll;
        const originalElQsa = browserGlobal.Element?.prototype?.querySelectorAll;

        if (typeof originalGbcr === 'function') {
            browserGlobal.Element.prototype.getBoundingClientRect = function () {
                getBoundingClientRectCount++;
                return originalGbcr.apply(this, arguments);
            };
        }
        if (typeof originalDocQsa === 'function') {
            browserGlobal.Document.prototype.querySelectorAll = function () {
                querySelectorAllCount++;
                return originalDocQsa.apply(this, arguments);
            };
        }
        if (typeof originalElQsa === 'function') {
            browserGlobal.Element.prototype.querySelectorAll = function () {
                querySelectorAllCount++;
                return originalElQsa.apply(this, arguments);
            };
        }

        try {
            context.chat.length = 0;
            context.chat.push({
                name: 'Scroll Tester',
                is_user: true,
                is_system: false,
                mes: 'seed prompt',
                extra: {},
            }, message);
            (chatElement ?? browserGlobal.document.body).appendChild(host);

            let maxStepMs = 0;
            const start = browserGlobal.performance.now();
            for (const step of steps) {
                const stepStart = browserGlobal.performance.now();
                message.mes = step;
                target.innerHTML = context.messageFormatting(step, message.name, message.is_system, message.is_user, messageId, {}, false);
                if (typeof browserGlobal.updateReasoningUI === 'function') {
                    browserGlobal.updateReasoningUI(messageId);
                }
                if (chatElement) {
                    chatElement.scrollTop = chatElement.scrollHeight;
                }
                await new Promise(resolve => browserGlobal.requestAnimationFrame(resolve));
                maxStepMs = Math.max(maxStepMs, browserGlobal.performance.now() - stepStart);
            }
            const totalMs = browserGlobal.performance.now() - start;

            return {
                available: true,
                stepCount,
                reasoningBytes: new TextEncoder().encode(reasoningText).length,
                totalMs: +totalMs.toFixed(2),
                averageStepMs: +(totalMs / Math.max(1, steps.length)).toFixed(2),
                maxStepMs: +maxStepMs.toFixed(2),
                getBoundingClientRectCount,
                querySelectorAllCount,
            };
        } finally {
            if (typeof originalGbcr === 'function') {
                browserGlobal.Element.prototype.getBoundingClientRect = originalGbcr;
            }
            if (typeof originalDocQsa === 'function') {
                browserGlobal.Document.prototype.querySelectorAll = originalDocQsa;
            }
            if (typeof originalElQsa === 'function') {
                browserGlobal.Element.prototype.querySelectorAll = originalElQsa;
            }
            host.remove();
            context.chat.splice(0, context.chat.length, ...previousChat);
        }
    }, fixture);
    const after = await readCdpPerfMetrics(cdpSession);

    return {
        ...result,
        cdp: diffCdpPerfMetrics(before, after),
    };
}

export async function measureSettingsInteractions(page, { cdpSession = null, idleDurationMs = 1000 } = {}) {
    const before = await readCdpPerfMetrics(cdpSession);
    const interaction = await page.evaluate(async () => {
        const browserGlobal = globalThis;
        const shell = browserGlobal.SillyBunnyShell;
        if (!shell || typeof shell.openTab !== 'function') {
            return { available: false, reason: 'settings-shell-unavailable' };
        }

        let mutationRecords = 0;
        const observer = new browserGlobal.MutationObserver((records) => {
            mutationRecords += records.length;
        });
        observer.observe(browserGlobal.document.documentElement, { childList: true, subtree: true, attributes: true });

        const tabsVisited = [];
        const openStart = browserGlobal.performance.now();
        try {
            await shell.openTab('right', 'extensions');
            tabsVisited.push('extensions');
            await new Promise(resolve => browserGlobal.requestAnimationFrame(() => browserGlobal.requestAnimationFrame(resolve)));
            const openMs = +(browserGlobal.performance.now() - openStart).toFixed(2);

            await shell.openTab('left', 'editor');
            tabsVisited.push('editor');
            await new Promise(resolve => browserGlobal.requestAnimationFrame(() => browserGlobal.requestAnimationFrame(resolve)));

            await shell.openTab('right', 'appearance');
            tabsVisited.push('appearance');
            await new Promise(resolve => browserGlobal.setTimeout(resolve, 400));

            const searchInput = browserGlobal.document.getElementById('sb-settings-search-input');
            let searchResults = 0;
            if (searchInput instanceof browserGlobal.HTMLInputElement) {
                searchInput.value = 'avatar';
                searchInput.dispatchEvent(new browserGlobal.Event('input', { bubbles: true }));
                await new Promise(resolve => browserGlobal.setTimeout(resolve, 150));
                searchResults = browserGlobal.document.querySelectorAll('#sb-settings-search-results .sb-search-entry, .sb-search-entry').length;
                searchInput.value = '';
                searchInput.dispatchEvent(new browserGlobal.Event('input', { bubbles: true }));
                await new Promise(resolve => browserGlobal.setTimeout(resolve, 250));
            }

            return {
                available: true,
                openMs,
                tabsVisited,
                searchResults,
                mutationRecords,
            };
        } finally {
            observer.disconnect();
        }
    });

    if (!interaction?.available) {
        return { ...interaction, idleBehindSettings: null, cdp: null };
    }

    const idleBehindSettings = await measureIdleActivity(page, { cdpSession, durationMs: idleDurationMs });
    await page.evaluate(() => {
        const homeToggle = globalThis.document.getElementById('sb-home-toggle');
        if (homeToggle instanceof globalThis.HTMLElement) {
            homeToggle.click();
        }
    }).catch(() => {});
    const after = await readCdpPerfMetrics(cdpSession);

    return {
        ...interaction,
        idleBehindSettings,
        cdp: diffCdpPerfMetrics(before, after),
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

export async function measureStreamingRender(page, fixture = createStreamingRenderFixture(), {
    plainPreviewModuleUrl = '/scripts/mobile-streaming.js',
} = {}) {
    const renderResult = await page.evaluate(async ({ steps, stepCount, fillerRepeat, codeRepeat, plainPreviewModuleUrl }) => {
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
            name: 'Seraphina',
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
            const totalMs = browserGlobal.performance.now() - start;

            let plainPreview = {
                available: false,
                reason: 'plain-preview-module-unavailable',
            };
            try {
                const { formatPlainTextStreamingPreview } = await import(plainPreviewModuleUrl);
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
                const previewTotalMs = browserGlobal.performance.now() - previewStart;

                plainPreview = {
                    available: true,
                    totalMs: previewTotalMs,
                    formatTotalMs: previewFormatTotalMs,
                    writeTotalMs: previewWriteTotalMs,
                    averageStepMs: previewTotalMs / Math.max(1, steps.length),
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
    }, {
        ...fixture,
        plainPreviewModuleUrl,
    });

    return {
        fixture: {
            stepCount: fixture.stepCount,
            fillerRepeat: fixture.fillerRepeat,
            codeRepeat: fixture.codeRepeat,
        },
        ...renderResult,
    };
}

export async function measureScrollFps(page) {
    return await page.evaluate(async () => {
        const browserGlobal = globalThis;
        const browserDocument = browserGlobal.document;
        const scroller = browserDocument.getElementById('chat') || browserDocument.scrollingElement;
        if (!scroller) {
            return {
                available: false,
                reason: 'scroll-container-unavailable',
                scrollRange: 0,
                movedPixels: 0,
            };
        }

        const measuredScrollRange = Number(scroller.scrollHeight) - Number(scroller.clientHeight);
        const scrollRange = Number.isFinite(measuredScrollRange) ? Math.max(0, measuredScrollRange) : 0;
        if (scrollRange <= 0) {
            return {
                available: false,
                reason: 'not-scrollable',
                scrollRange,
                movedPixels: 0,
            };
        }

        const originalScrollTop = Number(scroller.scrollTop) || 0;
        const startScrollTop = Math.min(scrollRange, Math.max(0, originalScrollTop));
        const downwardRange = scrollRange - startScrollTop;
        const upwardRange = startScrollTop;
        let direction = downwardRange >= upwardRange ? 1 : -1;
        const directionName = direction > 0 ? 'down' : 'up';
        const frameTimes = [];
        let movedPixels = 0;
        let previous = browserGlobal.performance.now();
        const start = previous;

        return new Promise(resolve => {
            function finish() {
                const averageFrame = frameTimes.reduce((total, frame) => total + frame, 0) / Math.max(1, frameTimes.length);
                const endScrollTop = Number(scroller.scrollTop) || 0;
                const result = {
                    available: movedPixels > 0,
                    frames: frameTimes.length,
                    averageFrame,
                    estimatedFps: averageFrame ? 1000 / averageFrame : 0,
                    scrollRange,
                    direction: directionName,
                    startScrollTop,
                    endScrollTop,
                    movedPixels,
                };

                scroller.scrollTop = originalScrollTop;
                if (movedPixels <= 0) {
                    result.reason = 'no-scroll-movement';
                }

                resolve(result);
            }

            function step(now) {
                frameTimes.push(now - previous);
                previous = now;

                const before = Number(scroller.scrollTop) || 0;
                let next = Math.min(scrollRange, Math.max(0, before + (direction * 24)));
                if (next === before) {
                    direction *= -1;
                    next = Math.min(scrollRange, Math.max(0, before + (direction * 24)));
                }
                scroller.scrollTop = next;
                const after = Number(scroller.scrollTop) || 0;
                movedPixels += Math.abs(after - before);

                if (now - start >= 1000) {
                    finish();
                    return;
                }

                browserGlobal.requestAnimationFrame(step);
            }

            browserGlobal.requestAnimationFrame(step);
        });
    });
}

async function settlePage(page, delayMs = 0) {
    await page.evaluate(async (delay) => {
        const browserGlobal = globalThis;
        await new Promise(resolve => browserGlobal.setTimeout(resolve, delay));
        await new Promise(resolve => browserGlobal.requestAnimationFrame(() => browserGlobal.requestAnimationFrame(resolve)));
    }, delayMs);
}

async function captureInstrumentationSnapshot(page) {
    return await page.evaluate(() => {
        const metrics = globalThis.__sillyBunnyPerfInstrumentation;
        return metrics ? JSON.parse(JSON.stringify(metrics)) : null;
    }).catch(() => null);
}

/**
 * The boot marks of the page, in boot order, with the time each was first made.
 * The page runs this function on its own, so it cannot use `readBootMarks` from the module that owns the names.
 */
export async function readBootMarksFromPage(page) {
    return await page.evaluate((names) => names.flatMap((name) => {
        const [first] = globalThis.performance.getEntriesByName(name);
        return first ? [{ name, startTime: first.startTime }] : [];
    }), BOOT_MARK_NAMES).catch(() => []);
}

async function measurePage(page, cdpSession = null) {
    const bootMarks = await readBootMarksFromPage(page);
    const metrics = await page.evaluate(() => {
        const browserGlobal = globalThis;
        const navigation = browserGlobal.performance.getEntriesByType('navigation')[0];
        const paint = Object.fromEntries(browserGlobal.performance.getEntriesByType('paint').map(entry => [entry.name, entry.startTime]));
        const resources = browserGlobal.performance.getEntriesByType('resource');
        const longTasks = browserGlobal.__sillyBunnyLongTaskMetrics.snapshot();

        return {
            navigation: navigation ? {
                domContentLoaded: navigation.domContentLoadedEventEnd,
                load: navigation.loadEventEnd,
                transferSize: navigation.transferSize,
                encodedBodySize: navigation.encodedBodySize,
                decodedBodySize: navigation.decodedBodySize,
            } : null,
            paint,
            longTasks,
            resourceCount: resources.length,
            heap: browserGlobal.performance.memory ? {
                usedJSHeapSize: browserGlobal.performance.memory.usedJSHeapSize,
                totalJSHeapSize: browserGlobal.performance.memory.totalJSHeapSize,
            } : null,
        };
    });
    const instrumentationAtReady = await captureInstrumentationSnapshot(page);

    const idle = await measureIdleActivity(page, { cdpSession });
    const streaming = await measureStreamingRender(page);
    await settlePage(page);
    const streamingReasoning = await measureStreamingWithReasoning(page, createStreamingReasoningFixture(), { cdpSession });
    await settlePage(page);
    const longChat = await measureLongChatRender(page);
    await settlePage(page, LONG_CHAT_SCROLL_SETTLE_MS);
    const scrollFps = await measureScrollFps(page);
    await settlePage(page);
    const settingsInteractions = await measureSettingsInteractions(page, { cdpSession });
    await settlePage(page);
    const chatRender = { streaming, streamingReasoning, longChat };
    const instrumentationAfterSynthetic = await captureInstrumentationSnapshot(page);
    const longTasksAfterSynthetic = await page.evaluate(() => globalThis.__sillyBunnyLongTaskMetrics.snapshot());

    return {
        ...metrics,
        bootMarks,
        longTasksAfterSynthetic,
        instrumentation: {
            ready: instrumentationAtReady,
            afterSynthetic: instrumentationAfterSynthetic,
        },
        idle,
        scrollFps,
        chatRender,
        settingsInteractions,
    };
}

export async function waitForAppReady(page) {
    const appEvents = await page.evaluateHandle(() => import('/scripts/events.js'));
    try {
        await page.waitForFunction(({ eventSource, event_types }) => {
            return eventSource.autoFireLastArgs.has(event_types.APP_READY);
        }, appEvents, { timeout: 60000 });
    } finally {
        await appEvents.dispose();
    }
    await page.waitForFunction(() => {
        const browserGlobal = globalThis;
        return typeof browserGlobal.SillyTavern?.getContext === 'function'
            && browserGlobal.document.getElementById('chat') instanceof browserGlobal.HTMLElement;
    }, null, { timeout: 60000 });
}

export function installLongTaskObserver() {
    const browserGlobal = globalThis;
    const unavailable = {
        available: false,
        reason: 'longtask-not-supported',
        count: null,
        totalDuration: null,
        longest: null,
    };
    let metrics = unavailable;
    let observer = null;
    const recordEntries = entries => {
        for (const entry of entries) {
            if (entry.entryType !== 'longtask' || !Number.isFinite(entry.duration)) {
                continue;
            }
            metrics.count++;
            metrics.totalDuration += entry.duration;
            metrics.longest = Math.max(metrics.longest, entry.duration);
        }
    };
    browserGlobal.__sillyBunnyLongTaskMetrics = {
        snapshot() {
            if (observer) {
                recordEntries(observer.takeRecords());
            }
            return { ...metrics };
        },
    };
    if (!browserGlobal.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
        return;
    }
    try {
        metrics = { available: true, count: 0, totalDuration: 0, longest: 0 };
        observer = new browserGlobal.PerformanceObserver(list => recordEntries(list.getEntries()));
        observer.observe({ type: 'longtask', buffered: true });
    } catch {
        observer?.disconnect();
        observer = null;
        metrics = { ...unavailable, reason: 'longtask-observer-setup-failed' };
    }
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

async function measureNavigation(page, action, cdpSession = null) {
    await page.evaluate(() => globalThis.performance.clearResourceTimings()).catch(() => {});
    await action();
    await waitForAppReady(page);
    const resources = await collectResourceTimings(page);
    const metrics = await measurePage(page, cdpSession);
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

export async function measureProfile(browser, profile, { url, serviceWorkers, instrumentation, cpuThrottleRate = 1 }) {
    const appliedCpuThrottleRate = parseCpuThrottleRate(cpuThrottleRate);
    const context = await browser.newContext({
        ...profile.contextOptions,
        serviceWorkers,
    });
    let cdpSession;

    try {
        await context.addInitScript(installResourceTimingBuffer, resourceTimingBufferSize);
        await context.addInitScript(installLongTaskObserver);

        if (instrumentation) {
            await context.addInitScript(installPerformanceInstrumentation);
        }

        const page = await context.newPage();
        cdpSession = await context.newCDPSession(page);
        await cdpSession.send('Emulation.setCPUThrottlingRate', { rate: appliedCpuThrottleRate });

        const cold = await measureNavigation(page, () => page.goto(url, { waitUntil: 'networkidle' }), cdpSession);
        const warm = await measureNavigation(page, () => page.reload({ waitUntil: 'networkidle' }), cdpSession);

        return {
            name: profile.name,
            label: profile.label,
            viewport: profile.contextOptions.viewport ?? null,
            cpuThrottleRate: appliedCpuThrottleRate,
            cold,
            warm,
        };
    } finally {
        try {
            await cdpSession?.detach();
        } finally {
            await context.close();
        }
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
    cpuThrottleRate = process.env.SILLYBUNNY_PERF_CPU_THROTTLE || 1,
    browserExecutablePath = process.env.SILLYBUNNY_PERF_BROWSER_EXECUTABLE || undefined,
    budgetPath = process.env.SILLYBUNNY_PERF_BUDGET || '',
} = {}) {
    const appliedCpuThrottleRate = parseCpuThrottleRate(cpuThrottleRate);
    await fs.mkdir(path.dirname(output), { recursive: true });

    const browser = await chromium.launch(browserExecutablePath ? { executablePath: browserExecutablePath } : {});
    const profiles = {};
    let hasProfileError = false;

    try {
        for (const profileName of profileNames) {
            const profile = PERFORMANCE_PROFILES[profileName];
            console.error(`Measuring ${profile.label}...`);
            try {
                profiles[profileName] = await measureProfile(browser, profile, { url, serviceWorkers, instrumentation, cpuThrottleRate: appliedCpuThrottleRate });
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
        cpuThrottleRate: appliedCpuThrottleRate,
        browserExecutablePath: browserExecutablePath || chromium.executablePath(),
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
