import { describe, expect, test } from '@jest/globals';

import {
    createMobileShellLifecycle,
    getMobileShellQuickActionKey,
    MOBILE_SHELL_BOTTOM_BAR_DEFAULT_VISIBLE_ACTION_IDS,
    MOBILE_SHELL_RAIL_CHARACTER_SHELL_KEY,
    MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK,
    MOBILE_SHELL_RAIL_QUICK_ACTION_LABEL_MAX_LENGTH,
    MOBILE_SHELL_RAIL_QUICK_ACTION_LIMIT,
    normalizeMobileShellQuickAction,
    resolveMobileShellBottomBarActionVisibility,
    resolveMobileShellQuickActionRoute,
    resolveMobileShellRailActionVisibility,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

const workspaceShell = {
    title: 'Workspace',
    proxyIcon: 'fa-compass',
};

const apiTab = {
    label: 'API',
    icon: 'fa-plug',
};

describe('mobile shell rail model lifecycle', () => {
    test('keeps rail quick-action constants explicit', () => {
        expect(MOBILE_SHELL_RAIL_QUICK_ACTION_LIMIT).toBe(12);
        expect(MOBILE_SHELL_RAIL_QUICK_ACTION_LABEL_MAX_LENGTH).toBe(36);
        expect(MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK).toBe('fa-bolt');
        expect(MOBILE_SHELL_RAIL_CHARACTER_SHELL_KEY).toBe('characters');
        expect(MOBILE_SHELL_BOTTOM_BAR_DEFAULT_VISIBLE_ACTION_IDS).toEqual([
            'view-files',
            'new-chat',
            'search-chat',
        ]);
    });

    test('normalizes legacy World Info routes before shell lookup', () => {
        expect(resolveMobileShellQuickActionRoute({
            shellKey: ' left ',
            tabId: ' World-Info ',
        })).toEqual({
            shellKey: 'characters',
            tabId: 'world-info',
        });

        expect(resolveMobileShellQuickActionRoute({
            shell: 'RIGHT',
            tab: 'Settings',
        })).toEqual({
            shellKey: 'right',
            tabId: 'settings',
        });
    });

    test('normalizes tab actions using injected shell and tab metadata', () => {
        expect(normalizeMobileShellQuickAction({
            action: {
                shellKey: 'left',
                tabId: 'api',
                icon: 'fa-solid FA-PLUG',
            },
            shellConfig: workspaceShell,
            tabConfig: apiTab,
        })).toEqual({
            type: 'tab',
            shellKey: 'left',
            tabId: 'api',
            icon: 'fa-plug',
            label: 'API',
        });
    });

    test('normalizes shell and custom actions without DOM metadata', () => {
        expect(normalizeMobileShellQuickAction({
            action: {
                type: 'shell',
                shellKey: 'left',
            },
            shellConfig: workspaceShell,
        })).toEqual({
            type: 'shell',
            shellKey: 'left',
            tabId: '',
            icon: 'fa-compass',
            label: 'Workspace',
        });

        expect(normalizeMobileShellQuickAction({
            action: {
                shellKey: 'left',
                tabId: 'api',
                displayText: 'Open the API settings',
                sectionLabel: 'Connection',
                dedupeKey: 'api-settings',
            },
            shellConfig: workspaceShell,
            tabConfig: apiTab,
        })).toEqual({
            type: 'custom',
            shellKey: 'left',
            tabId: 'api',
            icon: 'fa-bolt',
            label: 'Open the API settings',
            sectionLabel: 'Connection',
            displayText: 'Open the API settings',
            dedupeKey: 'api-settings',
        });
    });

    test('rejects malformed actions and clamps label/icon fields', () => {
        expect(normalizeMobileShellQuickAction()).toBeNull();
        expect(normalizeMobileShellQuickAction({
            action: { shellKey: 'missing', tabId: 'api' },
            shellConfig: null,
            tabConfig: apiTab,
        })).toBeNull();
        expect(normalizeMobileShellQuickAction({
            action: { shellKey: 'left' },
            shellConfig: workspaceShell,
        })).toBeNull();

        const normalizedAction = normalizeMobileShellQuickAction({
            action: {
                shellKey: 'left',
                tabId: 'api',
                icon: 'fa-regular fa-wrench',
                label: 'A label that is intentionally longer than thirty six characters',
            },
            shellConfig: workspaceShell,
            tabConfig: apiTab,
        });

        expect(normalizedAction.icon).toBe('fa-wrench');
        expect(normalizedAction.label).toBe('A label that is intentionally longe…');
    });

    test('derives the stable quick-action key from normalized fields', () => {
        expect(getMobileShellQuickActionKey({
            type: 'custom',
            shellKey: 'left',
            tabId: 'api',
            dedupeKey: 'api-settings',
        })).toBe('custom::left::api::api-settings');

        expect(getMobileShellQuickActionKey(null)).toBe('');
    });

    test('resolves built-in and quick-action rail groups without DOM types', () => {
        const builtInAction = {
            type: 'tab',
            shellKey: 'left',
            tabId: 'api',
            icon: 'fa-plug',
            label: 'API',
        };
        const customAction = {
            type: 'custom',
            shellKey: 'left',
            tabId: 'api',
            icon: 'fa-bolt',
            label: 'API Settings',
            dedupeKey: 'api-settings',
        };
        const plan = resolveMobileShellRailActionVisibility({
            hasVerticalRail: true,
            showCustomize: true,
            showQuickActions: true,
            builtInActions: [builtInAction],
            builtInActionKeys: [getMobileShellQuickActionKey(builtInAction)],
            quickActions: [builtInAction, customAction],
            builtInGroupLabel: 'Workspace',
        });

        expect(plan).toEqual({
            shouldHideCustomizeTabs: true,
            beforeGroups: [{
                type: 'built-in',
                label: 'Workspace',
                actions: [builtInAction],
            }],
            afterGroups: [{
                type: 'quick-actions',
                label: 'Quick Actions',
                actions: [customAction],
            }],
            quickActions: [customAction],
        });
    });

    test('keeps replacement actions and non-vertical rails explicit', () => {
        const replacementAction = {
            type: 'tab',
            shellKey: 'right',
            tabId: 'settings',
            icon: 'fa-screwdriver-wrench',
            label: 'Settings',
        };

        expect(resolveMobileShellRailActionVisibility({
            hasVerticalRail: true,
            showQuickActions: true,
            quickActions: [],
            replacementAction,
        }).afterGroups).toEqual([{
            type: 'quick-actions',
            label: 'Quick Actions',
            actions: [replacementAction],
        }]);

        expect(resolveMobileShellRailActionVisibility({
            hasVerticalRail: false,
            showCustomize: true,
            showQuickActions: true,
            builtInActions: [replacementAction],
            quickActions: [replacementAction],
        })).toEqual({
            shouldHideCustomizeTabs: false,
            beforeGroups: [],
            afterGroups: [],
            quickActions: [replacementAction],
        });
    });

    test('moves low-frequency bottom chat actions into mobile overflow only', () => {
        const actions = [
            { id: 'view-files', label: 'View chat files' },
            { id: 'new-chat', label: 'New chat' },
            { id: 'mass-delete', label: 'Mass delete chats' },
            { id: 'auto-name', label: 'Ask the LLM to name this chat' },
            { id: 'rename-chat', label: 'Rename chat' },
            { id: 'search-chat', label: 'Search chat' },
            { id: 'delete-chat', label: 'Delete chat' },
        ];

        expect(resolveMobileShellBottomBarActionVisibility({
            actions,
            isMobileViewport: false,
        })).toEqual({
            visibleActions: actions,
            overflowActions: [],
            shouldRenderOverflow: false,
        });

        expect(resolveMobileShellBottomBarActionVisibility({
            actions,
            isMobileViewport: true,
        })).toEqual({
            visibleActions: [actions[0], actions[1], actions[5]],
            overflowActions: [actions[2], actions[3], actions[4], actions[6]],
            shouldRenderOverflow: true,
        });
    });

    test('exposes rail model decisions through the lifecycle seam', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.railModel.limits).toEqual({
            quickActionLimit: MOBILE_SHELL_RAIL_QUICK_ACTION_LIMIT,
            labelMaxLength: MOBILE_SHELL_RAIL_QUICK_ACTION_LABEL_MAX_LENGTH,
            iconFallback: MOBILE_SHELL_RAIL_QUICK_ACTION_ICON_FALLBACK,
        });
        expect(lifecycle.railModel.bottomBarVisibleActionIds).toBe(MOBILE_SHELL_BOTTOM_BAR_DEFAULT_VISIBLE_ACTION_IDS);
        expect(lifecycle.railModel.resolveQuickActionRoute).toBe(resolveMobileShellQuickActionRoute);
        expect(lifecycle.railModel.normalizeQuickAction).toBe(normalizeMobileShellQuickAction);
        expect(lifecycle.railModel.getQuickActionKey).toBe(getMobileShellQuickActionKey);
        expect(lifecycle.railModel.resolveActionVisibility).toBe(resolveMobileShellRailActionVisibility);
        expect(lifecycle.railModel.resolveBottomBarActionVisibility).toBe(resolveMobileShellBottomBarActionVisibility);
    });
});
