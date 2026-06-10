import { describe, expect, test } from '@jest/globals';

import {
    createMobileShellLifecycle,
    deriveInlineDrawerPersistenceKey,
    resolveInlineDrawerAutoCloseSiblings,
} from '../public/scripts/mobile-shell-lifecycle/index.js';

describe('mobile shell inline drawer lifecycle', () => {
    test('resolves open sibling drawers to close without DOM state', () => {
        expect(resolveInlineDrawerAutoCloseSiblings({
            openedDrawerId: 'index:1',
            openDrawerIds: ['id:first', 'index:1', 'id:last', 'id:first', '', null],
            isMobileViewport: true,
        })).toEqual({
            closeIds: ['id:first', 'id:last'],
        });
    });

    test('keeps inline drawer auto-close viewport-agnostic for current behavior', () => {
        expect(resolveInlineDrawerAutoCloseSiblings({
            openedDrawerId: 'id:target',
            openDrawerIds: ['id:open'],
            isMobileViewport: false,
        })).toEqual({
            closeIds: ['id:open'],
        });
    });

    test('returns no sibling closes without an opened drawer id', () => {
        expect(resolveInlineDrawerAutoCloseSiblings({
            openedDrawerId: '',
            openDrawerIds: ['id:open'],
        })).toEqual({
            closeIds: [],
        });

        expect(resolveInlineDrawerAutoCloseSiblings()).toEqual({
            closeIds: [],
        });
    });

    test('pins id-based inline drawer persistence key format', () => {
        expect(deriveInlineDrawerPersistenceKey({
            drawerId: 'persona-drawer',
            context: {
                storagePrefix: 'sb-settings-inline-drawer',
                contextSegments: ['id:user-settings-block-content', 'extension:quick-replies'],
                drawerLabel: 'ignored-for-id',
                drawerIndex: 3,
            },
        })).toBe('sb-settings-inline-drawer:id:user-settings-block-content/extension:quick-replies:drawer-id:persona-drawer');
    });

    test('pins label-and-index inline drawer persistence key format', () => {
        expect(deriveInlineDrawerPersistenceKey({
            context: {
                storagePrefix: 'sb-settings-inline-drawer',
                contextSegments: ['world-entry:42'],
                drawerLabel: 'advanced-settings',
                drawerIndex: 2.4,
            },
        })).toBe('sb-settings-inline-drawer:world-entry:42:drawer:advanced-settings:2');
    });

    test('refuses to derive keys without storage context or drawer identity', () => {
        expect(deriveInlineDrawerPersistenceKey({
            drawerId: 'drawer',
            context: {
                storagePrefix: 'sb-settings-inline-drawer',
                contextSegments: [],
            },
        })).toBe('');

        expect(deriveInlineDrawerPersistenceKey({
            context: {
                storagePrefix: 'sb-settings-inline-drawer',
                contextSegments: ['id:settings'],
            },
        })).toBe('');
    });

    test('exposes inline drawer decisions through the lifecycle seam', () => {
        const lifecycle = createMobileShellLifecycle();

        expect(lifecycle.inlineDrawers.resolveAutoCloseSiblings).toBe(resolveInlineDrawerAutoCloseSiblings);
        expect(lifecycle.inlineDrawers.derivePersistenceKey).toBe(deriveInlineDrawerPersistenceKey);
    });
});
