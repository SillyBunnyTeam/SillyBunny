/* global globalThis */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

describe('companion dashboard compatibility route', () => {
    let dashboard;
    let unavailable;

    beforeEach(async () => {
        jest.resetModules();
        unavailable = false;
        jest.unstable_mockModule('../public/scripts/extensions/in-chat-agents/companion/companion-panel.js', () => ({
            isConversationModeActive: () => unavailable,
        }));
        dashboard = await import('../public/scripts/extensions/in-chat-agents/companion/companion-dashboard.js');
    });

    afterEach(() => { delete globalThis.$; });

    test('unconfigured public entry does not construct a modal', async () => {
        expect(await dashboard.openCompanionDashboard()).toBe(false);
    });

    test.each([false, true])('delegates to overview, including its Conversation Mode status (%s)', async mode => {
        unavailable = mode;
        const openOverview = jest.fn(async () => 'page');
        dashboard.configureCompanionDashboard({ openOverview });
        expect(await dashboard.openCompanionDashboard()).toBe('page');
        expect(openOverview).toHaveBeenCalledTimes(1);
    });

    test('wand installs once, starts hidden in Conversation Mode, and uses the public route', async () => {
        unavailable = true;
        let installed = false;
        const append = jest.fn(() => { installed = true; });
        const menuItem = { on: jest.fn(), toggle: jest.fn() };
        globalThis.$ = jest.fn(selector => {
            if (selector === '#ica_companions_wand_item') return { length: Number(installed) };
            if (selector === '#extensionsMenu') return { append };
            return menuItem;
        });
        const openOverview = jest.fn(async () => true);
        dashboard.configureCompanionDashboard({ openOverview });
        dashboard.initCompanionWandMenuItem();
        dashboard.initCompanionWandMenuItem();
        expect(append).toHaveBeenCalledTimes(1);
        expect(menuItem.toggle).toHaveBeenCalledWith(false);
        expect(menuItem.on.mock.calls[0][0]).toBe('click');
        await menuItem.on.mock.calls[0][1]();
        expect(openOverview).toHaveBeenCalledTimes(1);
    });
});
