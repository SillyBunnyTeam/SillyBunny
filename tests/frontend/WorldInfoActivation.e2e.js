import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';
import { BASELINE_SETTINGS, CROSS_CHECK_CASES, compareOutcomes, getSteps } from '../util/world-info-cases.js';

const BOOK = 'Rules Book';

async function scanInBrowser({ testCase, steps, baseline, bookName }) {
    const { checkWorldInfo, updateWorldInfoSettings } = await import('./scripts/world-info.js');
    const { chat_metadata } = await import('./script.js');
    const { eventSource, event_types } = await import('./scripts/events.js');
    const scanData = {
        trigger: 'normal',
        personaDescription: '',
        characterDescription: '',
        characterPersonality: '',
        characterDepthPrompt: '',
        scenario: '',
        creatorNotes: '',
        ...testCase.scanData,
    };

    delete chat_metadata.timedWorldInfo;
    const outcomes = [];
    for (const step of steps) {
        updateWorldInfoSettings({ ...baseline, ...testCase.settings, ...step.settings }, [bookName]);

        let loops = 0;
        const countLoop = () => {
            loops++;
        };
        eventSource.on(event_types.WORLDINFO_SCAN_DONE, countLoop);

        // Only rolls requested by the World Info scripts are scripted. Other page code keeps the real generator.
        const rolls = [step.random ?? testCase.random ?? []].flat();
        const realRandom = Math.random;
        let used = 0;
        Math.random = () => {
            if (!new Error().stack.includes('/scripts/world-info')) {
                return realRandom.call(Math);
            }
            if (!rolls.length) {
                throw new Error('This case rolled Math.random without setting random.');
            }
            return rolls[Math.min(used++, rolls.length - 1)];
        };

        try {
            const result = await checkWorldInfo(step.chat, step.maxContext ?? testCase.maxContext ?? 4000, false, scanData);
            const uids = [...result.allActivatedEntries].filter(entry => entry.world === bookName).map(entry => entry.uid);
            outcomes.push({ uids, loops });
        } finally {
            Math.random = realRandom;
            eventSource.removeListener(event_types.WORLDINFO_SCAN_DONE, countLoop);
        }
    }
    return outcomes;
}

test.describe('World Info activation in the browser', () => {
    test.describe.configure({ timeout: 120_000 });
    // A service worker that controls the page would answer requests before page.route sees them.
    test.use({ serviceWorkers: 'block' });
    test.beforeEach(async ({ page }) => {
        // Settings writes stay in this page, so the fixture book and its settings never reach the server.
        let settingsVersion = Date.now();
        await page.route('**/api/settings/save', route => route.fulfill({ status: 200, json: { version: ++settingsVersion } }));
        await testSetup.awaitST({ page });
    });

    for (const testCase of CROSS_CHECK_CASES) {
        test(`${testCase.name}`, async ({ page }) => {
            await page.route('**/api/worldinfo/get', route => {
                if (route.request().postDataJSON().name !== BOOK) {
                    return route.fallback();
                }
                const entries = Object.fromEntries(testCase.entries.map(item => [item.uid, item]));
                return route.fulfill({ json: { entries } });
            });

            const outcomes = await page.evaluate(scanInBrowser, { testCase, steps: getSteps(testCase), baseline: BASELINE_SETTINGS, bookName: BOOK });
            const { actual, expected } = compareOutcomes(testCase, outcomes);

            expect(actual).toEqual(expected);
        });
    }
});
