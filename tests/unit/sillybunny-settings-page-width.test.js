/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect -- Jest/jsdom tests use synchronous DOM assertions. */
import { describe, test, expect } from '@jest/globals';
import { PAGE_WIDTH_ATTRIBUTE, applyPageWidth, getPageWidth } from '../../public/scripts/sillybunny-settings-content.js';

describe('the page class of a settings page', () => {
    test('a tab that asks for the wide measure is a wide page', () => {
        expect(getPageWidth({ id: 'world-info', pageWidth: 'wide' })).toBe('wide');
    });

    test('a tab with no class, an unknown class or no definition at all is a preference page', () => {
        expect(getPageWidth({ id: 'interface' })).toBe('preference');
        expect(getPageWidth({ id: 'interface', pageWidth: 'preference' })).toBe('preference');
        expect(getPageWidth({ id: 'third-party', pageWidth: 'huge' })).toBe('preference');
        expect(getPageWidth(null)).toBe('preference');
        expect(getPageWidth(undefined)).toBe('preference');
    });

    test('the class is one attribute on the root of the page, and a page that is shown again is not written to', () => {
        const root = document.createElement('section');
        const writes = [];
        new MutationObserver(records => writes.push(...records)).observe(root, { attributes: true });

        applyPageWidth(root, { pageWidth: 'wide' });
        expect(root.getAttribute(PAGE_WIDTH_ATTRIBUTE)).toBe('wide');
        expect(PAGE_WIDTH_ATTRIBUTE).toBe('data-sb-page-width');
        applyPageWidth(root, { pageWidth: 'wide' });
        applyPageWidth(root, { id: 'import' });

        return Promise.resolve().then(() => {
            expect(root.getAttribute(PAGE_WIDTH_ATTRIBUTE)).toBe('preference');
            expect(writes.map(record => record.attributeName)).toEqual([PAGE_WIDTH_ATTRIBUTE, PAGE_WIDTH_ATTRIBUTE]);
        });
    });

    test('a root that is not an element is left alone', () => {
        expect(() => applyPageWidth(null, { pageWidth: 'wide' })).not.toThrow();
        expect(() => applyPageWidth(undefined, { pageWidth: 'wide' })).not.toThrow();
    });
});
