/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a pure rule and its attribute writes. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import {
    CONNECTION_ATTRIBUTE,
    createConnectionReflection,
    getConnectionState,
    setConnectionStatus,
    setStatusCheckPending,
} from '../../public/scripts/sillybunny-connection-state.js';

describe('getConnectionState', () => {
    test.each([
        ['an offline status with no check pending', { status: 'no_connection', pending: false }, 'offline'],
        ['a check in flight over an offline status', { status: 'no_connection', pending: true }, 'connecting'],
        ['a check in flight over a connected status', { status: 'Valid', pending: true }, 'connecting'],
        ['a check in flight before any status', { status: undefined, pending: true }, 'connecting'],
        ['a model name as the status', { status: 'gpt-stub', pending: false }, 'online'],
        ['a saved key that is not tested', { status: 'Key saved; press "Test Message" to verify.', pending: false }, 'online'],
        ['a bypassed status check', { status: 'Status check bypassed', pending: false }, 'online'],
        ['an empty string, which is not the offline status', { status: '', pending: false }, 'online'],
        ['no status yet and no check', { status: undefined, pending: false }, null],
    ])('%s is %s', (_label, input, expected) => {
        expect(getConnectionState(input)).toBe(expected);
    });
});

describe('the connection reflection', () => {
    const attributeOf = root => root.getAttribute(CONNECTION_ATTRIBUTE);

    test('writes nothing until a hook has run', () => {
        const root = document.createElement('div');
        createConnectionReflection(() => root);

        expect(root.hasAttribute(CONNECTION_ATTRIBUTE)).toBe(false);
    });

    test('a check that is pending before any status leaves the attribute at connecting, and none that ends with no status removes it', () => {
        const root = document.createElement('div');
        const reflection = createConnectionReflection(() => root);

        reflection.setPending(true);
        expect(attributeOf(root)).toBe('connecting');

        reflection.setPending(false);
        expect(root.hasAttribute(CONNECTION_ATTRIBUTE)).toBe(false);
    });

    test('a user with no key settles to offline at once', () => {
        const root = document.createElement('div');
        const reflection = createConnectionReflection(() => root);

        reflection.setStatus('no_connection');

        expect(attributeOf(root)).toBe('offline');
    });

    test('a failed first check goes connecting, then offline, though the status never changed', () => {
        const root = document.createElement('div');
        const reflection = createConnectionReflection(() => root);
        const seen = [];

        reflection.setStatus('no_connection');
        seen.push(attributeOf(root));
        reflection.setPending(true);
        seen.push(attributeOf(root));
        reflection.setStatus('no_connection');
        seen.push(attributeOf(root));
        reflection.setPending(false);
        seen.push(attributeOf(root));

        expect(seen).toEqual(['offline', 'connecting', 'connecting', 'offline']);
    });

    test('a check that succeeds goes connecting, then online', () => {
        const root = document.createElement('div');
        const reflection = createConnectionReflection(() => root);

        reflection.setStatus('no_connection');
        reflection.setPending(true);
        reflection.setStatus('Valid');
        expect(attributeOf(root)).toBe('connecting');
        reflection.setPending(false);

        expect(attributeOf(root)).toBe('online');
    });

    test('going offline again after being online shows offline', () => {
        const root = document.createElement('div');
        const reflection = createConnectionReflection(() => root);

        reflection.setStatus('Valid');
        reflection.setStatus('no_connection');

        expect(attributeOf(root)).toBe('offline');
    });

    test('a hook that changes nothing does not write the attribute again', () => {
        const root = document.createElement('div');
        const reflection = createConnectionReflection(() => root);
        reflection.setStatus('no_connection');
        const write = jest.spyOn(root, 'setAttribute');
        const remove = jest.spyOn(root, 'removeAttribute');

        reflection.setStatus('no_connection');
        reflection.setPending(false);

        expect(write).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
    });

    test('reads the root when a hook runs, so it needs no document at import', () => {
        const getRoot = jest.fn(() => document.createElement('div'));

        const reflection = createConnectionReflection(getRoot);
        expect(getRoot).not.toHaveBeenCalled();

        reflection.setStatus('no_connection');
        expect(getRoot).toHaveBeenCalled();
    });
});

describe('the app-wide hooks', () => {
    afterEach(() => {
        setStatusCheckPending(false);
        setConnectionStatus(undefined);
    });

    test('write the attribute on the document element', () => {
        setConnectionStatus('no_connection');
        expect(document.documentElement.getAttribute(CONNECTION_ATTRIBUTE)).toBe('offline');

        setStatusCheckPending(true);
        expect(document.documentElement.getAttribute(CONNECTION_ATTRIBUTE)).toBe('connecting');
    });

    test('are the only thing the module adds: no listener is added to the document or the window', () => {
        const onDocument = jest.spyOn(document, 'addEventListener');
        const onWindow = jest.spyOn(window, 'addEventListener');

        setConnectionStatus('Valid');
        setStatusCheckPending(true);
        setStatusCheckPending(false);

        expect(onDocument).not.toHaveBeenCalled();
        expect(onWindow).not.toHaveBeenCalled();
    });
});
