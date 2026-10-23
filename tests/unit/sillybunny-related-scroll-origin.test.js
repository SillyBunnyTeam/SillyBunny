/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, test, expect } from '@jest/globals';

await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: strings => strings.join('') }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu: jest.fn(), closeActionMenu: jest.fn(), isActionMenuOpen: () => false,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(), animateOut: jest.fn(), MOTION_EASE_OUT_QUAD: '', MOTION_FAST: 0,
    prefersReducedMotion: () => true,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/navigation.js', () => ({ confirmActiveEditorLeave: async () => true }));

const { mountEditorChrome } = await import('../../public/scripts/sillybunny-editor/chrome.js');
const { createObjectNavigation } = await import('../../public/scripts/sillybunny-editor/object-navigation.js');

test('Related Back compares the activation origin, not the pre-collapse scroll sample', async () => {
    const frames = [];
    const previousFrame = global.requestAnimationFrame;
    global.requestAnimationFrame = callback => frames.push(callback);
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    const root = document.createElement('section');
    const header = document.createElement('header');
    const toolbar = document.createElement('div');
    const content = document.createElement('div');
    const related = document.createElement('button');
    const controls = Object.fromEntries(['back', 'cancel', 'save', 'title', 'dirty'].map(key => [key, document.createElement('button')]));
    header.append(...Object.values(controls));
    content.append(related);
    root.append(header, toolbar, content);
    document.body.append(root);
    let chrome;
    try {
        chrome = mountEditorChrome({ root, header, toolbar, content, controls, onBack() {}, onCancel() {}, onSave() {} });
        Object.defineProperties(content, {
            scrollHeight: { value: 5000 },
            clientHeight: { get: () => header.classList.contains('sb-editor-chrome-hidden') ? 853 : 741 },
        });
        content.scrollTop = 4259;
        content.dispatchEvent(new Event('scroll'));
        const beforeClick = content.scrollTop;
        frames.shift()();
        expect(header.classList.contains('sb-editor-chrome-hidden')).toBe(true);
        expect(toolbar.classList.contains('sb-editor-chrome-hidden')).toBe(true);
        // jsdom has no layout engine; model the browser clamp as the 112px chrome collapses.
        content.scrollTop = Math.min(content.scrollTop, content.scrollHeight - content.clientHeight);
        const navigation = createObjectNavigation({ confirmLeave: async () => true });
        navigation.register('character-editor', {
            captureState: () => ({ scrollTop: content.scrollTop }),
            open: async (_target, { restore }) => { content.scrollTop = restore.scrollTop; return true; },
        });
        navigation.register('persona-editor', { open: async () => { content.scrollTop = 0; return true; } });
        let route;
        let activationScrollTop;
        related.addEventListener('click', () => { activationScrollTop = content.scrollTop; }, { capture: true, once: true });
        related.addEventListener('click', () => {
            route = navigation.navigate({ kind: 'persona-editor', id: 'persona.png' }, {
                from: { kind: 'character-editor', id: 'Alice.png' },
            });
        });
        related.click();
        await route;
        await navigation.back({ current: { kind: 'persona-editor', id: 'persona.png' }, fallback: jest.fn() });
        expect(beforeClick).toBe(4259);
        expect(activationScrollTop).toBe(4147);
        expect(content.scrollTop).toBe(activationScrollTop);
    } finally {
        chrome?.dispose();
        root.remove();
        global.requestAnimationFrame = previousFrame;
    }
});
