/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions are synchronous. */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const popupShow = jest.fn();
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((out, string, index) => out + string + (index < values.length ? values[index] : ''), ''),
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    POPUP_TYPE: { CONFIRM: 'confirm' },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    Popup: jest.fn().mockImplementation(function () {
        this.okButton = document.createElement('button');
        this.show = popupShow;
    }),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    isActionMenuOpen: () => false,
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-editor/picker.js', () => ({
    isPickerOpen: () => false,
}));

const { createObjectNavigation, objectNavigation } = await import('../../public/scripts/sillybunny-editor/object-navigation.js');
const { confirmActiveEditorLeave, registerEditorNavigation } = await import('../../public/scripts/sillybunny-editor/navigation.js');
let cleanups;

beforeEach(() => {
    jest.clearAllMocks();
    document.body.replaceChildren();
    cleanups = [];
});

afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    objectNavigation.clear();
    jest.restoreAllMocks();
    document.body.replaceChildren();
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function makeNavigation(options = {}) {
    const confirmLeave = jest.fn(async () => true);
    const notify = jest.fn();
    const navigation = createObjectNavigation({ confirmLeave, notify, ...options });
    const state = { scrollTop: 96, filter: 'active' };
    const origin = {
        open: jest.fn(async () => true),
        captureState: jest.fn(() => state),
        exists: jest.fn(() => true),
    };
    const destination = {
        open: jest.fn(async () => true),
        exists: jest.fn(() => true),
    };
    const unregisterOrigin = navigation.register('characters', origin);
    navigation.register('character', destination);
    const from = { kind: 'characters', id: null, section: 'list' };
    const target = { kind: 'character', id: 'Alice.png', section: 'details' };
    return { navigation, confirmLeave, notify, origin, destination, state, from, target, unregisterOrigin };
}

describe('object navigation transactions', () => {
    test('cancels before checking the destination or capturing origin state', async () => {
        const { navigation, confirmLeave, notify, origin, destination, from, target } = makeNavigation();
        confirmLeave.mockResolvedValue(false);

        expect(await navigation.navigate(target, { from })).toEqual({ ok: false, reason: 'cancelled' });
        expect(destination.exists).not.toHaveBeenCalled();
        expect(destination.open).not.toHaveBeenCalled();
        expect(origin.captureState).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(navigation.depth).toBe(0);
        expect(navigation.isRouting).toBe(false);
    });

    test.each(['kind', 'id'])('reports a missing destination %s after the leave guard', async missing => {
        const { navigation, confirmLeave, notify, origin, destination, from, target } = makeNavigation();
        if (missing === 'kind') target.kind = 'unknown';
        else destination.exists.mockReturnValue(false);

        expect(await navigation.navigate(target, { from })).toEqual({ ok: false, reason: 'missing' });
        expect(confirmLeave).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('missing', target);
        expect(origin.captureState).not.toHaveBeenCalled();
        expect(destination.open).not.toHaveBeenCalled();
        expect(navigation.depth).toBe(0);
    });

    test('reports an open returning false without pushing an origin', async () => {
        const { navigation, notify, destination, from, target } = makeNavigation();
        destination.open.mockResolvedValue(false);

        expect(await navigation.navigate(target, { from })).toEqual({ ok: false, reason: 'failed' });
        expect(notify).toHaveBeenCalledWith('failed', target);
        expect(navigation.depth).toBe(0);
        expect(navigation.isRouting).toBe(false);
    });

    test('catches and logs an open error without pushing an origin', async () => {
        const { navigation, notify, destination, from, target } = makeNavigation();
        const error = new Error('open failed');
        const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
        destination.open.mockRejectedValue(error);

        expect(await navigation.navigate(target, { from })).toEqual({ ok: false, reason: 'failed' });
        expect(logged).toHaveBeenCalledWith(expect.any(String), error);
        expect(notify).toHaveBeenCalledWith('failed', target);
        expect(navigation.depth).toBe(0);
        expect(navigation.isRouting).toBe(false);
    });

    test('awaits approval, captures state before open and pushes only after success', async () => {
        const approval = deferred();
        const opening = deferred();
        const { navigation, confirmLeave, origin, destination, from, target } = makeNavigation();
        confirmLeave.mockReturnValue(approval.promise);
        destination.open.mockReturnValue(opening.promise);

        const result = navigation.navigate(target, { from });
        expect(navigation.isRouting).toBe(true);
        expect(destination.exists).not.toHaveBeenCalled();
        expect(origin.captureState).not.toHaveBeenCalled();
        approval.resolve(true);
        await Promise.resolve();
        expect(origin.captureState).toHaveBeenCalledTimes(1);
        expect(destination.open).toHaveBeenCalledWith(target, { restore: null, isCurrent: expect.any(Function) });
        expect(destination.exists.mock.invocationCallOrder[0]).toBeLessThan(origin.captureState.mock.invocationCallOrder[0]);
        expect(origin.captureState.mock.invocationCallOrder[0]).toBeLessThan(destination.open.mock.invocationCallOrder[0]);
        expect(navigation.depth).toBe(0);
        expect(navigation.isRouting).toBe(true);
        opening.resolve(true);

        expect(await result).toEqual({ ok: true });
        expect(navigation.depth).toBe(1);
        expect(navigation.isRouting).toBe(false);
    });

    test('supports optional exists and captureState hooks', async () => {
        const { navigation, from, target } = makeNavigation();
        const open = jest.fn(async () => true);
        navigation.register('characters', { open });
        navigation.register('character', { open });

        expect(await navigation.navigate(target, { from })).toEqual({ ok: true });
        expect(await navigation.back({ current: target, fallback: jest.fn() })).toEqual({ ok: true });
        expect(open).toHaveBeenLastCalledWith(from, { restore: null, isCurrent: expect.any(Function) });
    });

    test('re-registration replaces a kind and a stale unregister cannot remove its replacement', async () => {
        const { navigation, destination, from, target } = makeNavigation();
        const staleUnregister = navigation.register('character', destination);
        const replacement = { open: jest.fn(async () => true) };
        const unregister = navigation.register('character', replacement);
        staleUnregister();

        expect(await navigation.navigate(target, { from })).toEqual({ ok: true });
        expect(replacement.open).toHaveBeenCalledTimes(1);
        expect(destination.open).not.toHaveBeenCalled();
        unregister();
        expect(await navigation.navigate(target, { from })).toEqual({ ok: false, reason: 'missing' });
    });

    test('trims the oldest origins at maxDepth', async () => {
        const { navigation, from, target, origin } = makeNavigation({ maxDepth: 2 });
        for (const id of ['oldest', 'middle', 'newest']) {
            await navigation.navigate(target, { from: { ...from, id } });
        }
        expect(navigation.depth).toBe(2);

        await navigation.back({ current: target, fallback: jest.fn() });
        expect(origin.open).toHaveBeenLastCalledWith({ ...from, id: 'newest' }, { restore: expect.any(Object), isCurrent: expect.any(Function) });
        await navigation.back({ current: target, fallback: jest.fn() });
        expect(origin.open).toHaveBeenLastCalledWith({ ...from, id: 'middle' }, { restore: expect.any(Object), isCurrent: expect.any(Function) });
        expect(navigation.depth).toBe(0);
    });

    test('the default stack retains eight successful origins', async () => {
        const { navigation, from, target } = makeNavigation();
        for (let index = 0; index < 10; index++) await navigation.navigate(target, { from });
        expect(navigation.depth).toBe(8);
    });

    test('resolves a functional origin after approval so Save can replace the create id', async () => {
        const approval = deferred();
        const { navigation, confirmLeave, origin, target, state } = makeNavigation();
        let groupId = 'create';
        const from = jest.fn(() => ({ kind: 'characters', id: groupId }));
        confirmLeave.mockReturnValueOnce(approval.promise);

        const result = navigation.navigate(target, { from });
        expect(from).not.toHaveBeenCalled();
        groupId = 'saved-group';
        approval.resolve(true);
        expect(await result).toEqual({ ok: true });
        expect(from).toHaveBeenCalledTimes(1);
        expect(from.mock.invocationCallOrder[0]).toBeLessThan(origin.captureState.mock.invocationCallOrder[0]);
        expect(await navigation.back({ current: target, fallback: jest.fn() })).toEqual({ ok: true });
        expect(origin.open).toHaveBeenCalledWith({ kind: 'characters', id: 'saved-group' }, {
            restore: state,
            isCurrent: expect.any(Function),
        });
    });

    test('does not resolve a functional origin when the guard is cancelled', async () => {
        const { navigation, confirmLeave, target } = makeNavigation();
        const from = jest.fn(() => ({ kind: 'characters', id: 'create' }));
        confirmLeave.mockResolvedValue(false);

        expect(await navigation.navigate(target, { from })).toEqual({ ok: false, reason: 'cancelled' });
        expect(from).not.toHaveBeenCalled();
    });

    test('does not resolve a functional origin when its pending guard is superseded', async () => {
        const approval = deferred();
        const { navigation, confirmLeave, target, from } = makeNavigation();
        const origin = jest.fn(() => from);
        confirmLeave.mockReturnValueOnce(approval.promise);
        const first = navigation.navigate(target, { from: origin });
        await navigation.navigate({ ...target, id: 'Bob.png' }, { from });
        approval.resolve(true);

        expect(await first).toEqual({ ok: false, reason: 'superseded' });
        expect(origin).not.toHaveBeenCalled();
    });

    test('invalidates a destination token as soon as a newer navigation starts, before its guard resolves', async () => {
        const opening = deferred();
        const approval = deferred();
        const { navigation, confirmLeave, destination, from, target } = makeNavigation();
        destination.open.mockReturnValueOnce(opening.promise);
        const first = navigation.navigate(target, { from });
        await Promise.resolve();
        const { isCurrent } = destination.open.mock.calls[0][1];
        expect(isCurrent()).toBe(true);

        confirmLeave.mockReturnValueOnce(approval.promise);
        const second = navigation.navigate({ ...target, id: 'Bob.png' }, { from });
        expect(isCurrent()).toBe(false);
        approval.resolve(true);
        expect(await second).toEqual({ ok: true });
        const newerIsCurrent = destination.open.mock.calls[1][1].isCurrent;
        expect(newerIsCurrent()).toBe(true);
        opening.resolve(false);
        expect(await first).toEqual({ ok: false, reason: 'superseded' });
        expect(newerIsCurrent()).toBe(true);
    });

    test('clear invalidates the token passed to an open destination', async () => {
        const opening = deferred();
        const { navigation, destination, from, target, notify } = makeNavigation();
        destination.open.mockReturnValueOnce(opening.promise);
        const result = navigation.navigate(target, { from });
        await Promise.resolve();
        const { isCurrent } = destination.open.mock.calls[0][1];
        expect(isCurrent()).toBe(true);
        navigation.clear();
        expect(isCurrent()).toBe(false);
        opening.resolve(false);
        expect(await result).toEqual({ ok: false, reason: 'superseded' });
        expect(notify).not.toHaveBeenCalled();
    });

    test('a newer navigation wins while the previous open is pending', async () => {
        const pending = deferred();
        const { navigation, destination, from, target, notify } = makeNavigation();
        destination.open.mockReturnValueOnce(pending.promise);
        const first = navigation.navigate(target, { from });
        await Promise.resolve();
        const secondTarget = { ...target, id: 'Bob.png' };

        expect(await navigation.navigate(secondTarget, { from })).toEqual({ ok: true });
        expect(navigation.isRouting).toBe(false);
        pending.resolve(true);
        expect(await first).toEqual({ ok: false, reason: 'superseded' });
        expect(navigation.depth).toBe(1);
        expect(navigation.canGoBack(secondTarget)).toBe(true);
        expect(navigation.canGoBack(target)).toBe(false);
        expect(notify).not.toHaveBeenCalled();
        expect(navigation.isRouting).toBe(false);
    });

    test('finishing a superseded request does not release the current routing flag', async () => {
        const firstOpening = deferred();
        const secondOpening = deferred();
        const { navigation, destination, from, target } = makeNavigation();
        destination.open.mockReturnValueOnce(firstOpening.promise).mockReturnValueOnce(secondOpening.promise);
        const first = navigation.navigate(target, { from });
        await Promise.resolve();
        const second = navigation.navigate({ ...target, id: 'Bob.png' }, { from });
        await Promise.resolve();

        firstOpening.resolve(true);
        expect(await first).toEqual({ ok: false, reason: 'superseded' });
        expect(navigation.isRouting).toBe(true);
        secondOpening.resolve(true);
        expect(await second).toEqual({ ok: true });
        expect(navigation.isRouting).toBe(false);
    });

    test('checks supersession immediately after awaiting the guard, even if it was cancelled', async () => {
        const pending = deferred();
        const { navigation, confirmLeave, destination, from, target } = makeNavigation();
        confirmLeave.mockReturnValueOnce(pending.promise);
        const first = navigation.navigate(target, { from });
        await navigation.navigate({ ...target, id: 'Bob.png' }, { from });
        pending.resolve(false);

        expect(await first).toEqual({ ok: false, reason: 'superseded' });
        expect(destination.open).toHaveBeenCalledTimes(1);
        expect(navigation.depth).toBe(1);
    });

    test('clear removes origins and invalidates an in-flight navigation', async () => {
        const pending = deferred();
        const { navigation, destination, from, target } = makeNavigation();
        await navigation.navigate(target, { from });
        destination.open.mockReturnValueOnce(pending.promise);
        const next = navigation.navigate(target, { from });
        await Promise.resolve();
        navigation.clear();

        expect(navigation.isRouting).toBe(false);
        expect(navigation.depth).toBe(0);
        expect(navigation.canGoBack(target)).toBe(false);
        pending.resolve(true);
        expect(await next).toEqual({ ok: false, reason: 'superseded' });
        expect(navigation.depth).toBe(0);
    });
});

describe('object navigation back', () => {
    test('matches kind and id, ignores section, restores state and pops only after success', async () => {
        const pending = deferred();
        const { navigation, from, target, origin, state } = makeNavigation();
        await navigation.navigate(target, { from });
        const fallback = jest.fn();
        origin.open.mockReturnValueOnce(pending.promise);

        expect(navigation.canGoBack({ ...target, section: 'another-section' })).toBe(true);
        const result = navigation.back({ current: { ...target, section: null }, fallback });
        await Promise.resolve();
        expect(navigation.depth).toBe(1);
        expect(origin.open).toHaveBeenCalledWith(from, { restore: state, isCurrent: expect.any(Function) });
        expect(navigation.isRouting).toBe(true);
        pending.resolve(true);

        expect(await result).toEqual({ ok: true });
        expect(navigation.depth).toBe(0);
        expect(navigation.isRouting).toBe(false);
        expect(fallback).not.toHaveBeenCalled();
    });

    test.each(['kind', 'id'])('clears and falls back when the current %s does not match', async property => {
        const { navigation, from, target, origin, confirmLeave } = makeNavigation();
        await navigation.navigate(target, { from });
        confirmLeave.mockClear();
        const fallback = jest.fn();
        const current = { ...target, [property]: 'different' };

        expect(navigation.canGoBack(current)).toBe(false);
        expect(await navigation.back({ current, fallback })).toEqual({ ok: false, reason: 'empty' });
        expect(navigation.depth).toBe(0);
        expect(fallback).toHaveBeenCalledTimes(1);
        expect(confirmLeave).not.toHaveBeenCalled();
        expect(origin.open).not.toHaveBeenCalled();
    });

    test('awaits the fallback with an empty stack', async () => {
        const pending = deferred();
        const { navigation, target } = makeNavigation();
        const fallback = jest.fn(() => pending.promise);
        const result = navigation.back({ current: target, fallback });

        expect(fallback).toHaveBeenCalledTimes(1);
        expect(navigation.canGoBack(target)).toBe(false);
        pending.resolve();
        expect(await result).toEqual({ ok: false, reason: 'empty' });
    });

    test.each(['kind', 'id'])('pops and falls back when the origin %s is missing', async missing => {
        const { navigation, from, target, origin, notify, unregisterOrigin } = makeNavigation();
        await navigation.navigate(target, { from });
        if (missing === 'kind') unregisterOrigin();
        else origin.exists.mockReturnValue(false);
        const fallback = jest.fn();

        expect(await navigation.back({ current: target, fallback })).toEqual({ ok: false, reason: 'missing' });
        expect(navigation.depth).toBe(0);
        expect(fallback).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('missing', from);
        expect(origin.open).not.toHaveBeenCalled();
    });

    test('keeps the origin when its leave guard is cancelled', async () => {
        const { navigation, from, target, origin, confirmLeave } = makeNavigation();
        await navigation.navigate(target, { from });
        confirmLeave.mockResolvedValue(false);
        const fallback = jest.fn();

        expect(await navigation.back({ current: target, fallback })).toEqual({ ok: false, reason: 'cancelled' });
        expect(navigation.depth).toBe(1);
        expect(origin.open).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });

    test('keeps the origin when reopening it fails', async () => {
        const { navigation, from, target, origin } = makeNavigation();
        await navigation.navigate(target, { from });
        origin.open.mockResolvedValue(false);
        const fallback = jest.fn();

        expect(await navigation.back({ current: target, fallback })).toEqual({ ok: false, reason: 'failed' });
        expect(navigation.depth).toBe(1);
        expect(fallback).not.toHaveBeenCalled();
    });

    test('a superseded back does not pop a newer successful navigation', async () => {
        const pending = deferred();
        const { navigation, from, target, origin } = makeNavigation();
        await navigation.navigate(target, { from });
        origin.open.mockReturnValueOnce(pending.promise);
        const backwards = navigation.back({ current: target, fallback: jest.fn() });
        await Promise.resolve();
        const newerTarget = { ...target, id: 'Bob.png' };
        await navigation.navigate(newerTarget, { from });
        pending.resolve(true);

        expect(await backwards).toEqual({ ok: false, reason: 'superseded' });
        expect(navigation.depth).toBe(2);
        expect(navigation.canGoBack(newerTarget)).toBe(true);
    });

    test.each(['navigate', 'back', 'clear'])('%s invalidates the token passed to a pending Back destination', async action => {
        const opening = deferred();
        const { navigation, from, target, origin } = makeNavigation();
        await navigation.navigate(target, { from });
        origin.open.mockReturnValueOnce(opening.promise);
        const backwards = navigation.back({ current: target, fallback: jest.fn() });
        await Promise.resolve();
        const { isCurrent } = origin.open.mock.calls[0][1];
        expect(isCurrent()).toBe(true);

        let newer;
        if (action === 'navigate') newer = navigation.navigate({ ...target, id: 'Bob.png' }, { from });
        else if (action === 'back') newer = navigation.back({ current: target, fallback: jest.fn() });
        else navigation.clear();
        expect(isCurrent()).toBe(false);
        await newer;
        opening.resolve(false);
        expect(await backwards).toEqual({ ok: false, reason: 'superseded' });
    });
});

describe('object navigation top-level clear', () => {
    test('sidebar clicks clear after the current route succeeds while an older open is still pending', async () => {
        const pending = deferred();
        const { navigation, destination, from, target } = makeNavigation();
        const button = document.createElement('button');
        button.className = 'top-level';
        document.body.append(button);
        cleanups.push(navigation.bindTopLevelClear('.top-level'));
        destination.open.mockReturnValueOnce(pending.promise);
        const first = navigation.navigate(target, { from });
        await Promise.resolve();

        expect(await navigation.navigate({ ...target, id: 'Bob.png' }, { from })).toEqual({ ok: true });
        expect(navigation.isRouting).toBe(false);
        expect(navigation.depth).toBe(1);
        button.click();
        expect(navigation.depth).toBe(0);
        pending.resolve(true);
        expect(await first).toEqual({ ok: false, reason: 'superseded' });
        expect(navigation.depth).toBe(0);
    });

    test('clears from bubbling descendant clicks, ignores unrelated clicks and unbinds', async () => {
        const { navigation, from, target } = makeNavigation();
        const button = document.createElement('button');
        button.className = 'top-level';
        const child = document.createElement('span');
        button.append(child);
        document.body.append(button);
        const unbind = navigation.bindTopLevelClear('.top-level');
        cleanups.push(unbind);
        await navigation.navigate(target, { from });

        document.body.click();
        expect(navigation.depth).toBe(1);
        child.click();
        expect(navigation.depth).toBe(0);
        await navigation.navigate(target, { from });
        unbind();
        child.click();
        expect(navigation.depth).toBe(1);
    });

    test('ignores top-level clicks during the guard and destination open', async () => {
        const approval = deferred();
        const opening = deferred();
        const { navigation, confirmLeave, destination, from, target } = makeNavigation();
        const button = document.createElement('button');
        button.className = 'top-level';
        document.body.append(button);
        cleanups.push(navigation.bindTopLevelClear('.top-level'));
        await navigation.navigate(target, { from });
        confirmLeave.mockReturnValueOnce(approval.promise);
        destination.open.mockReturnValueOnce(opening.promise);

        const result = navigation.navigate(target, { from });
        button.click();
        expect(navigation.depth).toBe(1);
        approval.resolve(true);
        await Promise.resolve();
        button.click();
        expect(navigation.depth).toBe(1);
        opening.resolve(true);
        expect(await result).toEqual({ ok: true });
        expect(navigation.depth).toBe(2);
        button.click();
        expect(navigation.depth).toBe(0);
    });

    test('the default singleton uses the active editor guard without binding top-level clearing', async () => {
        const target = { kind: 'test', id: 'target' };
        cleanups.push(objectNavigation.register('test', { open: async () => true }));

        expect(await objectNavigation.navigate(target, { from: { kind: 'origin' } })).toEqual({ ok: true });
        document.body.click();
        expect(objectNavigation.depth).toBe(1);
    });
});

describe('confirmActiveEditorLeave', () => {
    function registerSession({ open = true, active = true, dirty = true } = {}) {
        const session = {
            isOpen: () => open,
            isDirty: jest.fn(() => dirty),
            save: jest.fn(async () => true),
            discard: jest.fn(),
            flushDraft: jest.fn(),
        };
        cleanups.push(registerEditorNavigation({ session, isActive: () => active, close: jest.fn() }));
        return session;
    }

    test('resolves true without a registered editor', async () => {
        expect(await confirmActiveEditorLeave()).toBe(true);
        expect(popupShow).not.toHaveBeenCalled();
    });

    test('ignores inactive and closed editors and allows a clean active editor', async () => {
        const inactive = registerSession({ active: false });
        const closed = registerSession({ open: false });
        registerSession({ dirty: false });

        expect(await confirmActiveEditorLeave()).toBe(true);
        expect(inactive.isDirty).not.toHaveBeenCalled();
        expect(closed.isDirty).not.toHaveBeenCalled();
        expect(popupShow).not.toHaveBeenCalled();
    });

    test('delegates saving to the active dirty editor', async () => {
        const inactive = registerSession({ active: false });
        const active = registerSession();
        popupShow.mockResolvedValue(1);

        expect(await confirmActiveEditorLeave()).toBe(true);
        expect(popupShow).toHaveBeenCalledTimes(1);
        expect(active.save).toHaveBeenCalledTimes(1);
        expect(inactive.save).not.toHaveBeenCalled();
    });

    test('propagates cancellation from the active editor', async () => {
        const active = registerSession();
        popupShow.mockResolvedValue(0);

        expect(await confirmActiveEditorLeave()).toBe(false);
        expect(active.save).not.toHaveBeenCalled();
        expect(active.discard).not.toHaveBeenCalled();
    });
});
