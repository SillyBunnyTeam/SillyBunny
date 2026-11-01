/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for Getting Started persistence, signals and the toast. */
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
const { createGettingStartedState, getGettingStartedSteps, getStepLineSlot } = await import('../../public/scripts/sillybunny-home/getting-started.js');
const { GETTING_STARTED_STORAGE_KEY, loadGettingStartedSnapshot, serializeGettingStartedSnapshot } = await import('../../public/scripts/sillybunny-home/getting-started-storage.js');
const { ASSISTANT_AVATARS, BUNDLED_CARD_AVATARS, isBundledCard, pickCharacterVariant } = await import('../../public/scripts/sillybunny-home/bundled-cards.js');
const { createGettingStartedSignals, getUnconfirmedConnectionStatuses, isConfirmedConnection, isGeneratedReply, isUserMessage } = await import('../../public/scripts/sillybunny-home/getting-started-signals.js');
const { planCompletionToast, showCompletionToast } = await import('../../public/scripts/sillybunny-home/getting-started-toast.js');

const IDS = ['connect', 'preset', 'character', 'chat'];

/** A state that records what it would have written, the way the account storage would receive it. */
function createStoredState(snapshot) {
    const writes = [];
    const state = createGettingStartedState(IDS, { snapshot, save: written => writes.push(JSON.parse(JSON.stringify(written))) });
    return { state, writes };
}

const fresh = () => loadGettingStartedSnapshot({ raw: null, stepIds: IDS, firstRun: true }).snapshot;
const existing = () => loadGettingStartedSnapshot({ raw: null, stepIds: IDS, firstRun: false }).snapshot;

describe('the stored value of Getting Started', () => {
    test('a fresh install starts shown with every step open, and has to be written', () => {
        const { snapshot, isNew } = loadGettingStartedSnapshot({ raw: null, stepIds: IDS, firstRun: true });

        expect(isNew).toBe(true);
        expect(snapshot).toEqual({ hidden: false, hiddenBy: null, steps: { connect: null, preset: null, character: null, chat: null }, characterVariant: null });
    });

    test('an existing account with no value starts hidden until Show Getting Started', () => {
        const { snapshot, isNew } = loadGettingStartedSnapshot({ raw: null, stepIds: IDS, firstRun: false });

        expect(isNew).toBe(true);
        expect(snapshot.hidden).toBe(true);
        expect(snapshot.hiddenBy).toBe('account');
    });

    test('reads what the plan stores: hidden and a status for each step', () => {
        const raw = JSON.stringify({ hidden: false, steps: { connect: 'done', preset: 'skipped', character: null, chat: null } });

        const { snapshot, isNew } = loadGettingStartedSnapshot({ raw, stepIds: IDS, firstRun: false });

        expect(isNew).toBe(false);
        expect(snapshot.steps).toEqual({ connect: 'done', preset: 'skipped', character: null, chat: null });
        expect(snapshot.hidden).toBe(false);
    });

    test.each([
        ['not JSON', '{nope'],
        ['a number', '42'],
        ['an array', '[1,2]'],
        ['null', 'null'],
        ['an empty string', ''],
    ])('a value that is %s falls back to the defaults of the account without throwing', (_, raw) => {
        const first = loadGettingStartedSnapshot({ raw, stepIds: IDS, firstRun: true });
        const later = loadGettingStartedSnapshot({ raw, stepIds: IDS, firstRun: false });

        expect(first.isNew).toBe(true);
        expect(first.snapshot.hidden).toBe(false);
        expect(later.snapshot.hidden).toBe(true);
    });

    test('a partial value keeps its valid parts and takes the defaults for the rest', () => {
        const raw = JSON.stringify({ hidden: 'yes', steps: { connect: 'done', preset: 'finished', chat: 7, extra: 'done' } });

        const { snapshot } = loadGettingStartedSnapshot({ raw, stepIds: IDS, firstRun: true });

        expect(snapshot.steps).toEqual({ connect: 'done', preset: null, character: null, chat: null });
        expect(snapshot.hidden).toBe(false);
    });

    test('a character variant is kept only while the character step is done, and only if it is a known one', () => {
        const parse = value => loadGettingStartedSnapshot({ raw: JSON.stringify(value), stepIds: IDS, firstRun: false }).snapshot.characterVariant;

        expect(parse({ hidden: false, steps: { character: 'done' }, characterVariant: 'tewi' })).toBe('tewi');
        expect(parse({ hidden: false, steps: { character: 'skipped' }, characterVariant: 'tewi' })).toBeNull();
        expect(parse({ hidden: false, steps: { character: 'done' }, characterVariant: 'nobody' })).toBeNull();
    });

    test('round trips through the string the account storage keeps', () => {
        const { state } = createStoredState(fresh());
        state.markDone('connect');
        state.markDone('character', { variant: 'other' });

        const raw = serializeGettingStartedSnapshot(state.getSnapshot());

        expect(loadGettingStartedSnapshot({ raw, stepIds: IDS, firstRun: false }).snapshot).toEqual(state.getSnapshot());
        expect(JSON.parse(raw).steps).toEqual({ connect: 'done', preset: null, character: 'done', chat: null });
    });

    test('is stored under WelcomePage_GettingStarted', () => {
        expect(GETTING_STARTED_STORAGE_KEY).toBe('WelcomePage_GettingStarted');
    });
});

describe('the state, with a stored value behind it', () => {
    test('marks a step done once, and reports whether it changed', () => {
        const { state, writes } = createStoredState(fresh());

        expect(state.markDone('connect')).toBe(true);
        expect(state.markDone('connect')).toBe(false);

        expect(state.isDone('connect')).toBe(true);
        expect(state.getResolvedCount()).toBe(1);
        expect(writes).toHaveLength(1);
    });

    test('writes once for each change, and not for a call that changes nothing', () => {
        const { state, writes } = createStoredState(fresh());

        state.setSkipped('preset', true);
        state.setSkipped('preset', true);
        state.setSkipped('preset', false);
        state.setSkipped('preset', false);
        state.setHidden(true);
        state.setHidden(true);

        expect(writes).toHaveLength(3);
    });

    test('the change that resolves the last step and hides the tile is still one write', () => {
        const { state, writes } = createStoredState(fresh());
        ['connect', 'preset', 'character'].forEach(id => state.markDone(id));
        writes.length = 0;

        state.markDone('chat');

        expect(writes).toHaveLength(1);
        expect(writes[0].hidden).toBe(true);
    });

    test('never overwrites done: Skip does nothing to a finished step', () => {
        const { state, writes } = createStoredState(fresh());
        state.markDone('connect');
        writes.length = 0;

        state.setSkipped('connect', true);

        expect(state.isDone('connect')).toBe(true);
        expect(state.isSkipped('connect')).toBe(false);
        expect(writes).toHaveLength(0);
    });

    test('a skipped step that later gets its signal becomes done', () => {
        const { state } = createStoredState(fresh());
        state.setSkipped('preset', true);

        state.markDone('preset');

        expect(state.isDone('preset')).toBe(true);
        expect(state.isSkipped('preset')).toBe(false);
        expect(state.getResolvedCount()).toBe(1);
    });

    test('hides itself when every step is done or skipped, and says it was the auto-hide', () => {
        const { state } = createStoredState(fresh());
        state.setSkipped('preset', true);
        state.markDone('connect');
        state.markDone('character');
        expect(state.isHidden()).toBe(false);

        state.markDone('chat');

        expect(state.isHidden()).toBe(true);
        expect(state.getSnapshot().hiddenBy).toBe('auto');
    });

    test('un-skipping a step after the auto-hide brings the tile back', () => {
        const { state } = createStoredState(fresh());
        IDS.forEach(id => state.setSkipped(id, true));
        expect(state.isHidden()).toBe(true);

        state.setSkipped('chat', false);

        expect(state.isHidden()).toBe(false);
        expect(state.getSnapshot().hiddenBy).toBeNull();
    });

    test('un-skipping a step of an existing account does not show the tile: that waits for Show Getting Started', () => {
        const { state } = createStoredState(loadGettingStartedSnapshot({
            raw: JSON.stringify({ hidden: true, hiddenBy: 'account', steps: { connect: 'skipped' } }),
            stepIds: IDS,
            firstRun: false,
        }).snapshot);

        state.setSkipped('connect', false);

        expect(state.isHidden()).toBe(true);
        state.setHidden(false);
        expect(state.isHidden()).toBe(false);
        expect(state.getSnapshot().hiddenBy).toBeNull();
    });

    test('an existing account keeps counting progress while it is hidden', () => {
        const { state } = createStoredState(existing());

        state.markDone('connect');

        expect(state.isHidden()).toBe(true);
        expect(state.getResolvedCount()).toBe(1);
        state.setHidden(false);
        expect(state.getResolvedCount()).toBe(1);
    });

    test('Show Getting Started after the auto-hide shows the tile again and clears the reason', () => {
        const { state } = createStoredState(fresh());
        IDS.forEach(id => state.markDone(id));

        state.setHidden(false);

        expect(state.isHidden()).toBe(false);
        expect(state.getSnapshot().hiddenBy).toBeNull();
    });

    test('tells subscribers once for each change', () => {
        const { state } = createStoredState(fresh());
        const listener = jest.fn();
        state.subscribe(listener);

        state.markDone('connect');
        state.markDone('connect');

        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('persist writes the current value once, for a value that was never stored', () => {
        const { state, writes } = createStoredState(existing());

        state.persist();

        expect(writes).toEqual([existing()]);
    });

    test('remembers which kind of card finished step 3, and keeps the first answer', () => {
        const { state } = createStoredState(fresh());

        state.markDone('character', { variant: 'tewi' });
        state.markDone('character', { variant: 'reisen' });

        expect(state.getCharacterVariant()).toBe('tewi');
    });

    test('ignores a variant for another step and falls back to other for an unknown one', () => {
        const { state } = createStoredState(fresh());

        state.markDone('connect', { variant: 'tewi' });
        state.markDone('character', { variant: 'nobody' });

        expect(state.getCharacterVariant()).toBe('other');
    });
});

describe('the line of a step in the Getting Started window', () => {
    const [connect, , character] = getGettingStartedSteps();

    test('is the body of the step while it is open or skipped', () => {
        const { state } = createStoredState(fresh());
        state.setSkipped('character', true);

        expect(getStepLineSlot(character, state)).toBe('GS-3-BODY');
        expect(getStepLineSlot(connect, state)).toBe('GS-1-BODY');
    });

    test.each([
        ['reisen', 'GS-3-DONE-REISEN'],
        ['tewi', 'GS-3-DONE-TEWI'],
        ['other', 'GS-3-DONE-OTHER'],
    ])('is %s: the done line of step 3 follows the card that finished it', (variant, slot) => {
        const { state } = createStoredState(fresh());
        state.markDone('character', { variant });

        expect(getStepLineSlot(character, state)).toBe(slot);
    });

    test('keeps the body of the other steps once they are done', () => {
        const { state } = createStoredState(fresh());
        state.markDone('connect');

        expect(getStepLineSlot(connect, state)).toBe('GS-1-BODY');
    });
});

describe('which cards are bundled', () => {
    test('knows the cards of the default content and the optional assistant', () => {
        expect(BUNDLED_CARD_AVATARS).toEqual(['default_Seraphina.png', 'default_SillyBunnyGuide.png', 'default_AssistantNahida.png']);
        expect(BUNDLED_CARD_AVATARS.every(isBundledCard)).toBe(true);
    });

    test('a card of the user is not bundled', () => {
        expect(isBundledCard('Alice.png')).toBe(false);
        expect(isBundledCard('')).toBe(false);
        expect(isBundledCard(undefined)).toBe(false);
    });

    test('Reisen and Tewi are bundled once the list names their files, and they pick their own variant', () => {
        const assistants = { reisen: ['default_Reisen.png'], tewi: ['default_Tewi.png'] };

        expect(isBundledCard('default_Reisen.png', assistants)).toBe(true);
        expect(pickCharacterVariant('default_Reisen.png', assistants)).toBe('reisen');
        expect(pickCharacterVariant('default_Tewi.png', assistants)).toBe('tewi');
        expect(pickCharacterVariant('Alice.png', assistants)).toBe('other');
        expect(pickCharacterVariant(undefined, assistants)).toBe('other');
    });

    test('the files of Reisen and Tewi are the ones of the assistant registry', () => {
        expect(ASSISTANT_AVATARS).toEqual({ reisen: ['default_AssistantReisen.png'], tewi: ['default_AssistantTewi.png'] });
        expect(isBundledCard('default_AssistantReisen.png')).toBe(true);
        expect(isBundledCard('default_AssistantTewi.png')).toBe(true);
        expect(pickCharacterVariant('default_AssistantReisen.png')).toBe('reisen');
        expect(pickCharacterVariant('default_AssistantTewi.png')).toBe('tewi');
        expect(pickCharacterVariant('default_SillyBunnyGuide.png')).toBe('other');
    });
});

describe('which statuses finish Connect a Model', () => {
    test('the unconfirmed statuses are the four strings that the connection code reports', () => {
        expect(getUnconfirmedConnectionStatuses()).toEqual([
            'Key saved; press "Test Message" to verify.',
            'Invalid endpoint URL. Requests may fail.',
            'Invalid Azure endpoint URL. Requests may fail.',
            'Status check bypassed',
        ]);
    });

    test.each([
        ['no_connection', false],
        [undefined, false],
        ['', false],
        ['Key saved; press "Test Message" to verify.', false],
        ['Invalid endpoint URL. Requests may fail.', false],
        ['Invalid Azure endpoint URL. Requests may fail.', false],
        ['Status check bypassed', false],
        ['valid', true],
        ['Valid', true],
        ['gpt-5-mini', true],
    ])('%s is %s', (status, confirmed) => {
        expect(isConfirmedConnection(status)).toBe(confirmed);
    });
});

describe('which messages finish the steps', () => {
    test('only a message of the user is a message sent: the system messages of /sys and /comment are not', () => {
        expect(isUserMessage({ is_user: true, is_system: false })).toBe(true);
        expect(isUserMessage({ is_user: true })).toBe(true);
        expect(isUserMessage({ is_user: false, is_system: true })).toBe(false);
        expect(isUserMessage({ is_user: true, is_system: true })).toBe(false);
        expect(isUserMessage({ is_user: false })).toBe(false);
        expect(isUserMessage(undefined)).toBe(false);
    });

    test.each([
        ['normal', true],
        ['regenerate', true],
        ['swipe', true],
        ['append', true],
        ['continue', true],
        ['first_message', false],
        ['command', false],
        ['extension', false],
    ])('a character message of type %s is a generated reply: %s', (type, generated) => {
        expect(isGeneratedReply(type, { is_user: false, is_system: false })).toBe(generated);
    });

    test('a message of the user, a system message and a message that is gone are no generated reply', () => {
        expect(isGeneratedReply('normal', { is_user: true })).toBe(false);
        expect(isGeneratedReply('normal', { is_system: true })).toBe(false);
        expect(isGeneratedReply('normal', undefined)).toBe(false);
    });
});

describe('the signals', () => {
    let completed;
    let activation;

    beforeEach(() => {
        completed = [];
        activation = true;
    });

    function setup(snapshot = fresh(), options = {}) {
        const stored = createStoredState(snapshot);
        const signals = createGettingStartedSignals({
            state: stored.state,
            onStepCompleted: id => completed.push(id),
            assistantAvatars: { reisen: ['default_Reisen.png'], tewi: ['default_Tewi.png'] },
            hasUserActivation: () => activation,
            ...options,
        });
        return { ...stored, signals };
    }

    test('connect: a connection that the backend confirmed finishes the step', () => {
        const { state, signals } = setup();
        signals.appReady();

        signals.onlineStatusChanged('no_connection');
        expect(state.isDone('connect')).toBe(false);
        signals.onlineStatusChanged('valid');

        expect(state.isDone('connect')).toBe(true);
        expect(completed).toEqual(['connect']);
    });

    test.each([
        'Key saved; press "Test Message" to verify.',
        'Invalid endpoint URL. Requests may fail.',
        'Invalid Azure endpoint URL. Requests may fail.',
        'Status check bypassed',
    ])('connect: the status "%s" does not finish the step', (status) => {
        const { state, signals } = setup();
        signals.appReady();

        signals.onlineStatusChanged(status);

        expect(state.isDone('connect')).toBe(false);
        expect(completed).toEqual([]);
    });

    test('connect: the first reply a model generates finishes it, for a connection that reports no status', () => {
        const { state, signals } = setup();
        signals.appReady();
        signals.onlineStatusChanged('Status check bypassed');

        signals.replyGenerated();

        expect(state.isDone('connect')).toBe(true);
        expect(completed).toEqual(['connect']);
    });

    test('preset: a preset that the user applies after the app is ready finishes the step', () => {
        const { state, signals } = setup();
        signals.appReady();

        signals.presetChanged();

        expect(state.isDone('preset')).toBe(true);
        expect(completed).toEqual(['preset']);
    });

    test('preset: a load before the app is ready does not count, and one without a gesture of the user does not either', () => {
        const { state, signals } = setup();

        signals.presetChanged();
        signals.appReady();
        activation = false;
        signals.presetChanged();

        expect(state.isDone('preset')).toBe(false);
        expect(completed).toEqual([]);

        activation = true;
        signals.presetChanged();
        expect(state.isDone('preset')).toBe(true);
    });

    describe('where the browser reports user activation', () => {
        const original = Object.getOwnPropertyDescriptor(window.navigator, 'userActivation');
        const report = value => Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value });

        afterEach(() => {
            if (original) {
                Object.defineProperty(window.navigator, 'userActivation', original);
            } else {
                delete window.navigator.userActivation;
            }
        });

        test('the preset counts only while the user is active', () => {
            const { state, signals } = setup(fresh(), { hasUserActivation: undefined });
            signals.appReady();

            report({ isActive: false });
            signals.presetChanged();
            expect(state.isDone('preset')).toBe(false);

            report({ isActive: true });
            signals.presetChanged();
            expect(state.isDone('preset')).toBe(true);
        });

        test('a browser that does not report it counts every preset after the app is ready', () => {
            const { state, signals } = setup(fresh(), { hasUserActivation: undefined });
            signals.appReady();
            report(undefined);

            signals.presetChanged();

            expect(state.isDone('preset')).toBe(true);
        });
    });

    test('character: a card that is not bundled finishes the step with the variant other', () => {
        const { state, signals } = setup();
        signals.appReady();

        signals.libraryChanged(() => ['default_Seraphina.png', 'default_SillyBunnyGuide.png']);
        expect(state.isDone('character')).toBe(false);
        signals.libraryChanged(() => ['default_Seraphina.png', 'Alice.png']);

        expect(state.isDone('character')).toBe(true);
        expect(state.getCharacterVariant()).toBe('other');
        expect(completed).toEqual(['character']);
    });

    test('character: once the step is done the library is not read again', () => {
        const { signals } = setup(fresh());
        signals.appReady();
        signals.libraryChanged(() => ['Alice.png']);
        const read = jest.fn(() => ['Bob.png']);

        signals.libraryChanged(read);

        expect(read).not.toHaveBeenCalled();
    });

    test.each([
        ['default_Reisen.png', 'reisen'],
        ['default_Tewi.png', 'tewi'],
        ['default_Seraphina.png', 'other'],
        [undefined, 'other'],
    ])('character: opening a chat with %s finishes the step as %s', (avatar, variant) => {
        const { state, signals } = setup();
        signals.appReady();

        signals.chatOpened('Chat - 2026', avatar);

        expect(state.isDone('character')).toBe(true);
        expect(state.getCharacterVariant()).toBe(variant);
    });

    test.each([
        ['default_SillyBunnyGuide.png', 'other'],
        ['default_Reisen.png', 'reisen'],
        ['default_Tewi.png', 'tewi'],
    ])('character: opening a Conversation thread with %s finishes the step as %s', (avatar, variant) => {
        const { state, signals } = setup();
        signals.appReady();

        signals.conversationThreadOpened(avatar);

        expect(state.isDone('character')).toBe(true);
        expect(state.getCharacterVariant()).toBe(variant);
        expect(completed).toEqual(['character']);
    });

    test('character: leaving to Home, where no chat is open, finishes nothing', () => {
        const { state, signals } = setup();
        signals.appReady();

        signals.chatOpened(undefined, undefined);
        signals.chatOpened('', undefined);

        expect(state.isDone('character')).toBe(false);
    });

    test('chat: the first message the user sends finishes the step', () => {
        const { state, signals } = setup();
        signals.appReady();

        signals.messageSent();

        expect(state.isDone('chat')).toBe(true);
        expect(completed).toEqual(['chat']);
    });

    test('a step that is already done is not announced again', () => {
        const { signals } = setup();
        signals.appReady();

        signals.messageSent();
        signals.messageSent();

        expect(completed).toEqual(['chat']);
    });

    test('a skipped step that gets its signal becomes done without an announcement', () => {
        const { state, signals } = setup();
        signals.appReady();
        state.setSkipped('connect', true);

        signals.onlineStatusChanged('valid');

        expect(state.isDone('connect')).toBe(true);
        expect(state.getResolvedCount()).toBe(1);
        expect(completed).toEqual([]);
    });

    test('signals before the app is ready record progress and announce nothing, so a connection that boot restores is silent', () => {
        const { state, signals } = setup();

        signals.onlineStatusChanged('valid');
        signals.chatOpened('Chat', 'Alice.png');

        expect(state.isDone('connect')).toBe(true);
        expect(state.isDone('character')).toBe(true);
        expect(completed).toEqual([]);
    });

    test('while Getting Started is hidden the progress is still recorded', () => {
        const { state, signals } = setup(existing());
        signals.appReady();

        signals.onlineStatusChanged('valid');

        expect(state.isDone('connect')).toBe(true);
        expect(state.getResolvedCount()).toBe(1);
    });
});

describe('the completion toast', () => {
    const steps = getGettingStartedSteps();

    function stateWith({ done = [], skipped = [], hidden = false } = {}) {
        const { state } = createStoredState(fresh());
        done.forEach(id => state.markDone(id));
        skipped.forEach(id => state.setSkipped(id, true));
        if (hidden) {
            state.setHidden(true);
        }
        return state;
    }

    test('names the finished step and the next step that is still open', () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });

        expect(plan.finished.title).toBe('Connect a Model');
        expect(plan.next.id).toBe('preset');
        expect(plan.next.target).toBe('presets');
    });

    test('skips steps that are resolved, and wraps to an earlier open step after the last one', () => {
        const middle = planCompletionToast({ steps, state: stateWith({ done: ['connect', 'preset'], skipped: [] }), finishedId: 'preset' });
        const last = planCompletionToast({ steps, state: stateWith({ done: ['chat'], skipped: ['connect', 'preset'] }), finishedId: 'chat' });

        expect(middle.next.id).toBe('character');
        expect(last.next.id).toBe('character');
    });

    test('shows nothing when no step is left open, or while Getting Started is hidden', () => {
        const everything = stateWith({ done: ['connect', 'character', 'chat'], skipped: ['preset'] });
        everything.setHidden(false);

        expect(planCompletionToast({ steps, state: everything, finishedId: 'chat' })).toBeNull();
        expect(planCompletionToast({ steps, state: stateWith({ done: ['connect'], hidden: true }), finishedId: 'connect' })).toBeNull();
    });

    function showWith(plan, deps = {}) {
        const toast = {
            success: jest.fn(() => 'toast'),
            clear: jest.fn(),
        };
        const openTarget = jest.fn();
        showCompletionToast(plan, { toast, openTarget, ...deps });
        return { toast, openTarget };
    }

    test('is one toast with the finished step as its title, copy placeholders, the next step and one Show Me button', () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });

        const { toast } = showWith(plan);

        expect(toast.success).toHaveBeenCalledTimes(1);
        const [message, title, options] = toast.success.mock.calls[0];
        expect(title.textContent).toBe('Connect a Model');
        expect(message.querySelectorAll('button')).toHaveLength(1);
        expect(message.querySelector('button').textContent).toBe('Show Me');
        expect(message.querySelector('[data-sb-copy-slot="GS-TOAST-DONE"]').textContent).toBe('TODO(copy)');
        expect(message.querySelector('[data-sb-copy-slot="GS-TOAST-NEXT"]').textContent).toBe('TODO(copy)');
        expect(message.textContent).toContain('Set Up a Preset');
        expect(options.escapeHtml).toBe(false);
    });

    test('the copy slots are marked the way every copy placeholder is', () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });

        const [message] = showWith(plan).toast.success.mock.calls[0];

        message.querySelectorAll('[data-sb-copy-slot]').forEach((node) => {
            expect(node.dataset.sbCopyPlaceholder).toBe('true');
        });
    });

    test('Show Me opens the target of the next step and closes the toast', async () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });
        const { toast, openTarget } = showWith(plan);
        const [message] = toast.success.mock.calls[0];

        message.querySelector('button').click();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(openTarget).toHaveBeenCalledWith('presets');
        expect(toast.clear).toHaveBeenCalledWith('toast', { force: true });
    });

    test('moves the toast into the top dialog once it is shown, as the app does for its other toasts', () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });
        const order = [];
        const toast = { success: jest.fn(() => { order.push('shown'); return 'toast'; }), clear: jest.fn() };

        showCompletionToast(plan, { toast, openTarget: jest.fn(), moveIntoDialog: () => order.push('moved') });

        expect(order).toEqual(['shown', 'moved']);
    });

    test('keeps the container in a dialog that is still open when the toast hides, and forgets the toast', () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });
        const toast = { success: jest.fn(() => 'toast'), clear: jest.fn() };
        const moveIntoDialog = jest.fn();
        showCompletionToast(plan, { toast, openTarget: jest.fn(), moveIntoDialog });
        moveIntoDialog.mockClear();
        toast.clear.mockClear();

        toast.success.mock.calls[0][2].onHidden();
        showCompletionToast(plan, { toast, openTarget: jest.fn(), moveIntoDialog });

        expect(moveIntoDialog).toHaveBeenCalledTimes(2);
        // A toast that is gone is not cleared again when the next one shows.
        expect(toast.clear).not.toHaveBeenCalled();
    });

    test('Show Me closes the Getting Started window first, and opens the target once it has gone', async () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });
        const order = [];
        const toast = { success: jest.fn(() => 'toast'), clear: jest.fn() };
        const closeWindow = async () => { order.push('closing'); await Promise.resolve(); order.push('closed'); };
        showCompletionToast(plan, { toast, openTarget: target => order.push(`open ${target}`), closeWindow });

        const button = toast.success.mock.calls[0][0].querySelector('button');
        button.click();
        button.click();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(order).toEqual(['closing', 'closed', 'open presets']);
    });

    test('a new toast replaces the one that is still on screen', () => {
        const plan = planCompletionToast({ steps, state: stateWith({ done: ['connect'] }), finishedId: 'connect' });
        const toast = { success: jest.fn(() => 'toast'), clear: jest.fn() };

        showCompletionToast(plan, { toast, openTarget: jest.fn() });
        showCompletionToast(plan, { toast, openTarget: jest.fn() });

        expect(toast.clear).toHaveBeenCalledWith('toast', { force: true });
    });
});
