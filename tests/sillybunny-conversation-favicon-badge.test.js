/**
 * @jest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const conversationState = {
    conversationWorkspaceOpen: false,
    faviconUpdateToken: 0,
    originalDocumentTitle: '',
    originalFaviconHref: '',
};

await jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ playMessageSound: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/chrome.js', () => ({ selectConversationThread: jest.fn() }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/constants.js', () => ({ CHROME_IDS: { palsToggle: 'pals-toggle' }, SAFE_TOAST_OPTIONS: {} }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/context.js', () => ({
    clearLegacyConversationUnreadStorage: () => 0,
    getActiveConversationBranch: () => ({}),
    getConversationGroupById: () => null,
    getConversationGroupIdForAvatar: () => '',
    getConversationPersonaId: () => '',
    getConversationStore: () => ({ characters: {} }),
    getConversationThreadKey: () => '',
    getConversationThreadStore: () => ({ branches: {} }),
    getCurrentCharAvatar: () => '',
    isConversationThreadKeyForPersona: () => true,
    parseConversationThreadKey: () => ({}),
    parsePositiveInt: (value, fallback) => fallback,
    persistConversationStore: jest.fn(),
    shouldSurfaceConversationNotification: () => false,
}));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/media.js', () => ({ getCharacterForAvatar: () => null }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/settings-store.js', () => ({ getSettings: () => ({}), isConversationModeEnabled: () => true }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/state.js', () => ({ conversationState }));
await jest.unstable_mockModule('../public/scripts/sillybunny-conversation/typing.js', () => ({ stripPreviewText: value => String(value || '') }));

const { getFaviconLink, updateConversationFaviconBadge } = await import('../public/scripts/sillybunny-conversation/notifications.js');

const LINKS = `
    <link rel="icon" type="image/png" sizes="16x16" href="http://localhost/img/sillybunny/logo-16.png">
    <link rel="icon" type="image/png" sizes="32x32" href="http://localhost/img/sillybunny/logo-32.png">
    <link rel="icon" type="image/png" sizes="64x64" href="http://localhost/img/sillybunny/logo-64.png">`;

describe('Conversation unread favicon badge', () => {
    const originalImage = window.Image;
    const createElement = document.createElement.bind(document);
    let drawn;

    beforeEach(() => {
        document.head.innerHTML = LINKS;
        Object.assign(conversationState, { faviconUpdateToken: 0, originalFaviconHref: '' });
        drawn = [];
        window.Image = class {
            set src(value) {
                this.loadedFrom = value;
                queueMicrotask(() => this.onload?.());
            }
        };
        jest.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => {
            if (tag !== 'canvas') {
                return createElement(tag, ...rest);
            }
            const context = {
                imageSmoothingEnabled: true,
                beginPath() {},
                arc() {},
                fill() {},
                fillText() {},
                drawImage(image, ...box) {
                    drawn.push({ from: image.loadedFrom, box, smoothing: context.imageSmoothingEnabled });
                },
            };
            return { width: 0, height: 0, getContext: () => context, toDataURL: () => 'data:image/png;base64,BADGE' };
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        window.Image = originalImage;
    });

    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    test('starts from the 32 px logo link, not the first icon link', () => {
        expect(getFaviconLink().getAttribute('sizes')).toBe('32x32');
        expect(conversationState.originalFaviconHref).toBe('http://localhost/img/sillybunny/logo-32.png');
    });

    test('falls back to the first icon link when there is no 32 px one', () => {
        document.head.innerHTML = '<link rel="icon" sizes="16x16" href="http://localhost/a.png">';
        expect(getFaviconLink().getAttribute('href')).toBe('http://localhost/a.png');
    });

    test('draws the 32 px logo 1:1 with smoothing off and puts the badge on that link only', async () => {
        updateConversationFaviconBadge(3);
        await settle();

        expect(drawn).toEqual([{ from: 'http://localhost/img/sillybunny/logo-32.png', box: [0, 0, 32, 32], smoothing: false }]);
        const hrefs = [...document.querySelectorAll('link[rel~="icon"]')].map(link => link.getAttribute('href'));
        expect(hrefs).toEqual(['http://localhost/img/sillybunny/logo-16.png', 'data:image/png;base64,BADGE', 'http://localhost/img/sillybunny/logo-64.png']);
    });

    test('restores the 32 px logo when nothing is unread, and when the badge cannot be drawn', async () => {
        updateConversationFaviconBadge(2);
        await settle();
        updateConversationFaviconBadge(0);
        expect(getFaviconLink().getAttribute('href')).toBe('http://localhost/img/sillybunny/logo-32.png');

        window.Image = class {
            set src(_value) {
                queueMicrotask(() => this.onerror?.());
            }
        };
        updateConversationFaviconBadge(4);
        await settle();
        expect(getFaviconLink().getAttribute('href')).toBe('http://localhost/img/sillybunny/logo-32.png');
    });
});
