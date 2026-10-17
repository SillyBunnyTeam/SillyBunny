/** @jest-environment jsdom */
/* eslint-disable playwright/prefer-web-first-assertions -- This suite uses Jest/jsdom, not Playwright locators. */
import { jest, describe, test, expect } from '@jest/globals';
import { createStatusPage } from '../../public/scripts/sillybunny-editor/status-page.js';

describe('createStatusPage', () => {
    test('builds the status page with decorative icon, title and description', () => {
        const { element } = createStatusPage({ icon: 'book', title: 'Empty library', description: 'Choose a book.' });
        expect(element.tagName).toBe('DIV');
        expect(element.className).toBe('sb-status-page');
        expect(element.getAttribute('role')).toBe('status');
        expect(element.querySelector('i').classList.contains('fa-solid')).toBe(true);
        expect(element.querySelector('i').classList.contains('fa-book')).toBe(true);
        expect(element.querySelector('i').classList.contains('sb-status-page__icon')).toBe(true);
        expect(element.querySelector('i').getAttribute('aria-hidden')).toBe('true');
        expect(element.querySelector('h3').className).toBe('sb-status-page__title');
        expect(element.querySelector('h3').textContent).toBe('Empty library');
        expect(element.querySelector('p').className).toBe('sb-status-page__description');
        expect(element.querySelector('p').textContent).toBe('Choose a book.');
        expect(element.querySelector('.sb-status-page__actions')).toBeNull();
    });

    test('supports compact mode and omits an absent description', () => {
        const { element } = createStatusPage({ icon: 'book', title: 'Library', compact: true });
        expect(element.classList.contains('sb-status-page--compact')).toBe(true);
        expect(element.querySelector('p')).toBeNull();
    });

    test('creates native action buttons, with primary state and callbacks', () => {
        const onPrimary = jest.fn();
        const onSecondary = jest.fn();
        const { element } = createStatusPage({
            icon: 'book', title: 'Library', actions: [
                { label: 'Create', primary: true, onActivate: onPrimary },
                { label: 'Import', onActivate: onSecondary },
            ],
        });
        const actions = element.querySelector('.sb-status-page__actions');
        const [primary, secondary] = actions.children;
        expect(primary.tagName).toBe('BUTTON');
        expect(primary.type).toBe('button');
        expect(primary.className).toBe('menu_button sb-status-page__action menu_button_primary is-suggested');
        expect(primary.textContent).toBe('Create');
        expect(secondary.className).toBe('menu_button sb-status-page__action');
        expect(secondary.textContent).toBe('Import');
        primary.click();
        secondary.click();
        expect(onPrimary).toHaveBeenCalledTimes(1);
        expect(onSecondary).toHaveBeenCalledTimes(1);
    });

    test('updates icon, title and description in place without rebuilding action buttons', () => {
        const onActivate = jest.fn();
        const page = createStatusPage({ icon: 'book', title: 'Library', actions: [{ label: 'Create', onActivate }] });
        const button = page.element.querySelector('button');
        const heading = page.element.querySelector('h3');
        page.update({ icon: 'circle-info', title: 'Updated', description: 'New description' });
        expect(page.element.querySelector('.sb-status-page__icon').classList.contains('fa-book')).toBe(false);
        expect(page.element.querySelector('.sb-status-page__icon').classList.contains('fa-circle-info')).toBe(true);
        expect(page.element.querySelector('h3')).toBe(heading);
        expect(heading.textContent).toBe('Updated');
        expect(heading.nextSibling.textContent).toBe('New description');
        expect(heading.nextSibling.nextSibling.className).toBe('sb-status-page__actions');
        expect(page.element.querySelector('button')).toBe(button);
        button.click();
        expect(onActivate).toHaveBeenCalledTimes(1);
    });

    test('partial updates preserve omitted properties and can remove or restore descriptions', () => {
        const page = createStatusPage({ icon: 'book', title: 'Library', description: 'Original' });
        page.update({ title: 'Updated' });
        expect(page.element.querySelector('p').textContent).toBe('Original');
        expect(page.element.querySelector('i').classList.contains('fa-book')).toBe(true);
        page.update({ description: '' });
        expect(page.element.querySelector('p')).toBeNull();
        expect(page.element.querySelector('h3').textContent).toBe('Updated');
        page.update({ description: 'Restored' });
        expect(page.element.querySelectorAll('p')).toHaveLength(1);
        expect(page.element.querySelector('p').textContent).toBe('Restored');
        page.update({ description: 'Changed' });
        expect(page.element.querySelectorAll('p')).toHaveLength(1);
        expect(page.element.querySelector('p').textContent).toBe('Changed');
    });

    test('renders dynamic text and icon names without HTML injection', () => {
        const payload = '<img src=x onerror=alert(1)>';
        const page = createStatusPage({ icon: payload, title: payload, description: payload, actions: [{ label: payload }] });
        expect(page.element.querySelector('img')).toBeNull();
        expect(page.element.querySelector('h3').textContent).toBe(payload);
        expect(page.element.querySelector('p').textContent).toBe(payload);
        expect(page.element.querySelector('button').textContent).toBe(payload);
        page.update({ title: '<b>Updated</b>', description: '<i>Updated</i>' });
        expect(page.element.querySelector('h3').textContent).toBe('<b>Updated</b>');
        expect(page.element.querySelector('p').textContent).toBe('<i>Updated</i>');
        expect(page.element.querySelector('h3').children).toHaveLength(0);
    });
});
