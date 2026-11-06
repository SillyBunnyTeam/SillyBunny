/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { createBanner } from '../../public/scripts/sillybunny-editor/banner.js';

beforeEach(() => document.body.replaceChildren());

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
