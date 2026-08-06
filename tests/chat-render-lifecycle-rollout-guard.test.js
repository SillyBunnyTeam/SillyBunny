import { describe, expect, test } from '@jest/globals';

import {
    CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY,
    CHAT_RENDER_LIFECYCLE_ROUTE,
    CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS,
    resolveChatRenderLifecycleRollout,
} from '../public/scripts/chat-render-lifecycle/rollout-guard.js';

function createStorage(value) {
    return {
        getItem: key => key === CHAT_RENDER_LIFECYCLE_ROLLOUT_KEY ? value : null,
    };
}

describe('chat render lifecycle rollout guard', () => {
    test('defaults lifecycle routing off', () => {
        expect(resolveChatRenderLifecycleRollout()).toEqual({
            enabled: false,
            source: 'default',
        });
    });

    test('accepts an explicit default-on option for controlled tests', () => {
        expect(resolveChatRenderLifecycleRollout({ defaultEnabled: true })).toEqual({
            enabled: true,
            source: 'default',
        });
    });

    test('uses route defaults when explicit overrides are absent', () => {
        expect(resolveChatRenderLifecycleRollout({
            route: CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD,
            routeDefaults: {
                ...CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS,
                [CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD]: true,
            },
        })).toEqual({
            enabled: true,
            source: 'default',
        });
    });

    test('enables only proven lifecycle routes by default', () => {
        expect(Object.keys(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS).sort()).toEqual(
            Object.values(CHAT_RENDER_LIFECYCLE_ROUTE).sort(),
        );
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.BOTTOM_SCROLL]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.MEDIA_RESIZE]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.MESSAGE_UPDATE]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.MOBILE_VIEWPORT]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.REDISPLAY_BATCH]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.REPLACE_MESSAGE]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.SHOW_MORE_BATCH]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_PROGRESS]).toBe(true);
        expect(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS[CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_START]).toBe(true);

        const disabledRoutes = Object.entries(CHAT_RENDER_LIFECYCLE_ROUTE_DEFAULTS)
            .filter(([route]) => ![
                CHAT_RENDER_LIFECYCLE_ROUTE.BOTTOM_SCROLL,
                CHAT_RENDER_LIFECYCLE_ROUTE.INITIAL_LOAD,
                CHAT_RENDER_LIFECYCLE_ROUTE.MEDIA_RESIZE,
                CHAT_RENDER_LIFECYCLE_ROUTE.MESSAGE_UPDATE,
                CHAT_RENDER_LIFECYCLE_ROUTE.MOBILE_VIEWPORT,
                CHAT_RENDER_LIFECYCLE_ROUTE.REDISPLAY_BATCH,
                CHAT_RENDER_LIFECYCLE_ROUTE.REPLACE_MESSAGE,
                CHAT_RENDER_LIFECYCLE_ROUTE.SHOW_MORE_BATCH,
                CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_PROGRESS,
                CHAT_RENDER_LIFECYCLE_ROUTE.STREAM_START,
            ].includes(route))
            .map(([, enabled]) => enabled);

        expect(disabledRoutes.every(value => value === false)).toBe(true);
    });

    test('device-local kill switch enables lifecycle routing', () => {
        expect(resolveChatRenderLifecycleRollout({ storage: createStorage('true') })).toEqual({
            enabled: true,
            source: 'storage',
        });
    });

    test('device-local kill switch disables lifecycle routing', () => {
        expect(resolveChatRenderLifecycleRollout({
            defaultEnabled: true,
            storage: createStorage('false'),
        })).toEqual({
            enabled: false,
            source: 'storage',
        });
    });

    test('query override wins over storage', () => {
        expect(resolveChatRenderLifecycleRollout({
            queryValue: 'true',
            storage: createStorage('false'),
        })).toEqual({
            enabled: true,
            source: 'query',
        });
    });

    test('ignores invalid override values', () => {
        expect(resolveChatRenderLifecycleRollout({
            defaultEnabled: true,
            queryValue: 'maybe',
            storage: createStorage('wat'),
        })).toEqual({
            enabled: true,
            source: 'default',
        });
    });
});
