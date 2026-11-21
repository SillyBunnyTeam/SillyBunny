/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { createBanner } from '../../public/scripts/sillybunny-editor/banner.js';

const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

function stubMatchMedia(reduced) {
    window.matchMedia = jest.fn(query => ({ matches: reduced && query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} }));
}

/** Gives the banner a laid-out height, as a browser would, and records every animation it is asked to play. */
function stubAnimation(element, height = 48) {
    const finishers = [];
    element.getBoundingClientRect = () => ({ width: 600, height, top: 0, left: 0, right: 600, bottom: height });
    element.animate = jest.fn((keyframes, options) => {
        const animation = {
            keyframes, options, oncancel: null,
            finished: new Promise(resolve => finishers.push(resolve)),
            cancel: jest.fn(),
        };
        return animation;
    });
    return { finishAll: async () => { finishers.splice(0).forEach(finish => finish()); await Promise.resolve(); await Promise.resolve(); } };
}

/** Lays the parts out at a width, the way `measure` reads them. */
function stubWidths(banner, { container, title, button }) {
    Object.defineProperty(banner.element, 'clientWidth', { configurable: true, value: container });
    const parts = [banner.element.querySelector('.sb-banner__title'), banner.element.querySelector('.sb-banner__action')];
    const widths = [title, button];
    parts.forEach((part, index) => {
        if (part) part.getBoundingClientRect = () => ({ width: widths[index], height: 20 });
    });
}

beforeEach(() => {
    document.body.replaceChildren();
    document.body.className = '';
    stubMatchMedia(false);
});

describe('createBanner', () => {
    test('renders accessible text and an explicit action without interpreting markup', () => {
        const activate = jest.fn();
        const banner = createBanner({ title: '<img src=x>', actionLabel: 'Turn On', onActivate: activate });
        document.body.append(banner.element);
        expect(banner.element.getAttribute('role')).toBe('status');
        expect(banner.element.querySelector('img')).toBeNull();
        expect(banner.element.firstElementChild.textContent).toBe('<img src=x>');
        const button = banner.element.querySelector('button');
        expect(button.type).toBe('button');
        expect(button.textContent).toBe('Turn On');
        button.click();
        expect(activate).toHaveBeenCalledTimes(1);
    });

    test('reveals and hides the same nodes without activating the action', () => {
        const activate = jest.fn();
        const banner = createBanner({ title: 'Off', actionLabel: 'Turn On', onActivate: activate });
        const button = banner.element.lastElementChild;
        banner.setRevealed(false);
        expect(banner.element.hidden).toBe(true);
        banner.setRevealed(true);
        expect(banner.element.hidden).toBe(false);
        expect(banner.element.lastElementChild).toBe(button);
        expect(activate).not.toHaveBeenCalled();
    });

    test('destroy removes both the node and its action listener', () => {
        const activate = jest.fn();
        const banner = createBanner({ title: 'Off', actionLabel: 'Turn On', onActivate: activate });
        document.body.append(banner.element);
        const button = banner.element.lastElementChild;
        banner.destroy();
        button.click();
        expect(banner.element.isConnected).toBe(false);
        expect(activate).not.toHaveBeenCalled();
    });
});

describe('createBanner parts', () => {
    test('has one title, takes its text as text, and has one normal button only when an action is given', () => {
        const withButton = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        expect(withButton.element.className).toBe('sb-banner');
        expect(withButton.element.firstElementChild.className).toBe('sb-banner__title');
        const buttons = withButton.element.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].className).toBe('menu_button sb-banner__action');
        const titleOnly = createBanner({ title: 'Saved on this device' });
        expect(titleOnly.element.querySelector('button')).toBeNull();
        expect(titleOnly.element.children).toHaveLength(1);
    });

    test('a suggested button uses the suggested style and a default one does not', () => {
        const suggested = createBanner({ title: 'Update', actionLabel: 'Update Now', onActivate: () => {}, buttonStyle: 'suggested' });
        expect(suggested.element.querySelector('button').classList.contains('menu_button_primary')).toBe(true);
        expect(suggested.element.querySelector('button').classList.contains('is-suggested')).toBe(true);
        const plain = createBanner({ title: 'Update', actionLabel: 'Update Now', onActivate: () => {} });
        expect(plain.element.querySelector('button').classList.contains('menu_button_primary')).toBe(false);
    });

    test('setTitle replaces the text without reading it as markup', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        const title = banner.element.firstElementChild;
        banner.setTitle('<b>Back</b> online');
        expect(banner.element.firstElementChild).toBe(title);
        expect(title.textContent).toBe('<b>Back</b> online');
        expect(title.querySelector('b')).toBeNull();
    });

    test('setButton adds, replaces and removes the one button, and the old action never runs again', () => {
        const first = jest.fn();
        const second = jest.fn();
        const banner = createBanner({ title: 'Needs an update' });
        banner.setButton({ label: 'Update', onActivate: first });
        const button = banner.element.querySelector('button');
        expect(banner.element.querySelectorAll('button')).toHaveLength(1);
        button.click();
        expect(first).toHaveBeenCalledTimes(1);

        banner.setButton({ label: 'Update All', onActivate: second, style: 'suggested' });
        expect(banner.element.querySelectorAll('button')).toHaveLength(1);
        const replaced = banner.element.querySelector('button');
        expect(replaced.textContent).toBe('Update All');
        expect(replaced.classList.contains('menu_button_primary')).toBe(true);
        replaced.click();
        button.click();
        expect(second).toHaveBeenCalledTimes(1);
        expect(first).toHaveBeenCalledTimes(1);

        banner.setButton(null);
        expect(banner.element.querySelector('button')).toBeNull();
        replaced.click();
        expect(second).toHaveBeenCalledTimes(1);
    });

    test('the live region role and the title stay put when the button changes', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        const title = banner.element.firstElementChild;
        banner.setButton(null);
        banner.setButton({ label: 'Retry', onActivate: () => {} });
        expect(banner.element.getAttribute('role')).toBe('status');
        expect(banner.element.firstElementChild).toBe(title);
        expect(banner.element.lastElementChild.tagName).toBe('BUTTON');
    });
});

describe('createBanner reveal', () => {
    test('starts hidden when asked and shows at once without a transition when nothing is laid out', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {}, revealed: false });
        document.body.append(banner.element);
        expect(banner.element.hidden).toBe(true);
        expect(banner.isRevealed()).toBe(false);
        banner.show();
        expect(banner.element.hidden).toBe(false);
        expect(banner.isRevealed()).toBe(true);
        banner.hide();
        expect(banner.element.hidden).toBe(true);
    });

    test('show reveals from no height with the reveal transition and leaves no inline style behind', async () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {}, revealed: false });
        document.body.append(banner.element);
        const { finishAll } = stubAnimation(banner.element, 48);
        banner.show();
        expect(banner.element.hidden).toBe(false);
        expect(banner.element.animate).toHaveBeenCalledTimes(1);
        const [keyframes, options] = banner.element.animate.mock.calls[0];
        expect(keyframes[0]).toMatchObject({ height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' });
        expect(keyframes[1]).toMatchObject({ height: '48px', opacity: 1 });
        expect(options).toMatchObject({ duration: 250, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' });
        expect(banner.element.style.overflow).toBe('hidden');
        await finishAll();
        expect(banner.element.style.overflow).toBe('');
        expect(banner.element.hidden).toBe(false);
    });

    test('hide is logical at once, keeps the strip on screen while it collapses, then drops it', async () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        document.body.append(banner.element);
        const { finishAll } = stubAnimation(banner.element, 48);
        banner.hide();
        expect(banner.element.hidden).toBe(true);
        expect(banner.isRevealed()).toBe(false);
        const [keyframes, options] = banner.element.animate.mock.calls[0];
        expect(keyframes[0]).toMatchObject({ height: '48px', opacity: 1 });
        expect(keyframes[1]).toMatchObject({ height: '0px', opacity: 0 });
        expect(options).toMatchObject({ duration: 250, easing: 'cubic-bezier(0.25, 0.1, 0.25, 1)' });
        expect(banner.element.style.display).not.toBe('');
        expect(banner.element.inert).toBe(true);
        await finishAll();
        expect(banner.element.style.display).toBe('');
        expect(banner.element.inert).toBeFalsy();
        expect(banner.element.hidden).toBe(true);
    });

    test('a second show or hide to the same state plays nothing', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        document.body.append(banner.element);
        stubAnimation(banner.element);
        banner.setRevealed(true);
        banner.show();
        expect(banner.element.animate).not.toHaveBeenCalled();
        banner.hide();
        banner.hide();
        banner.setRevealed(false);
        expect(banner.element.animate).toHaveBeenCalledTimes(1);
    });

    test('hiding while it is still opening leaves it hidden and plays the way out from where it is', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {}, revealed: false });
        document.body.append(banner.element);
        stubAnimation(banner.element);
        banner.show();
        banner.hide();
        expect(banner.element.hidden).toBe(true);
        expect(banner.element.animate).toHaveBeenCalledTimes(2);
        banner.show();
        expect(banner.element.hidden).toBe(false);
    });

    test.each([
        ['the system asks for reduced motion', () => stubMatchMedia(true)],
        ['the body carries reduced-motion', () => document.body.classList.add('reduced-motion')],
    ])('plays no motion when %s', (_name, reduce) => {
        reduce();
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {}, revealed: false });
        document.body.append(banner.element);
        stubAnimation(banner.element);
        banner.show();
        expect(banner.element.hidden).toBe(false);
        banner.hide();
        expect(banner.element.hidden).toBe(true);
        expect(banner.element.animate).not.toHaveBeenCalled();
        expect(banner.element.style.display).toBe('');
    });

    test('announces politely when it appears: the title text is written again once the region is shown', async () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {}, revealed: false });
        document.body.append(banner.element);
        const title = banner.element.firstElementChild;
        const records = [];
        const observer = new MutationObserver(list => records.push(...list));
        observer.observe(title, { childList: true, characterData: true });
        banner.show();
        await frame();
        await frame();
        observer.disconnect();
        expect(records.length).toBeGreaterThan(0);
        expect(title.textContent).toBe('Offline');
        expect(banner.element.getAttribute('role')).toBe('status');
    });

    test('does not announce a banner that was hidden again before the next frame', async () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {}, revealed: false });
        document.body.append(banner.element);
        const title = banner.element.firstElementChild;
        banner.show();
        banner.hide();
        const records = [];
        const observer = new MutationObserver(list => records.push(...list));
        observer.observe(title, { childList: true, characterData: true });
        await frame();
        await frame();
        observer.disconnect();
        expect(records).toHaveLength(0);
    });

    test('destroy while it is collapsing cancels the motion and removes the node', async () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        document.body.append(banner.element);
        stubAnimation(banner.element);
        banner.hide();
        banner.destroy();
        expect(banner.element.isConnected).toBe(false);
        expect(banner.element.style.display).toBe('');
    });
});

describe('createBanner layout', () => {
    test('centres the title when it fits with room for the button on both sides', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        document.body.append(banner.element);
        stubWidths(banner, { container: 800, title: 250, button: 100 });
        banner.measure();
        expect(banner.element.dataset.layout).toBe('centered');
    });

    test('starts the title at the edge when it fits beside the button but not centred', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        document.body.append(banner.element);
        stubWidths(banner, { container: 400, title: 250, button: 100 });
        banner.measure();
        expect(banner.element.dataset.layout).toBeUndefined();
    });

    test('puts the button below the title when they do not fit side by side', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        document.body.append(banner.element);
        stubWidths(banner, { container: 300, title: 250, button: 100 });
        banner.measure();
        expect(banner.element.dataset.layout).toBe('stacked');
    });

    test('counts the button as at least 84px wide beside the title', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'OK', onActivate: () => {} });
        document.body.append(banner.element);
        stubWidths(banner, { container: 357, title: 250, button: 40 });
        banner.measure();
        expect(banner.element.dataset.layout).toBe('stacked');
        stubWidths(banner, { container: 358, title: 250, button: 40 });
        banner.measure();
        expect(banner.element.dataset.layout).toBeUndefined();
    });

    test('a banner with only a title centres it', () => {
        const banner = createBanner({ title: 'Saved on this device' });
        document.body.append(banner.element);
        stubWidths(banner, { container: 300, title: 250 });
        banner.measure();
        expect(banner.element.dataset.layout).toBe('title');
    });

    test('measure leaves no inline style on the parts', () => {
        const banner = createBanner({ title: 'Offline', actionLabel: 'Reconnect', onActivate: () => {} });
        document.body.append(banner.element);
        stubWidths(banner, { container: 800, title: 250, button: 100 });
        banner.measure();
        expect(banner.element.firstElementChild.getAttribute('style')).toBeNull();
        expect(banner.element.lastElementChild.getAttribute('style')).toBeNull();
    });
});
