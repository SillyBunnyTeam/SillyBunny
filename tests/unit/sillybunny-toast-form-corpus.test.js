/**
 * @jest-environment jsdom
 */
/* eslint-disable jest/no-standalone-expect -- The `check` of a row is an assertion that runs inside the shared test body. */
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// One row for each way a caller reaches toastr: core, bundled code, the third-party extensions that the survey read
// (`research-extensions.md`) and the options that toastr documents. Each row runs through the real jQuery and the real
// toastr, and the form that `classifyToast` gives the element toastr returned must be the expected one.
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
    translate: value => value,
}));
await jest.unstable_mockModule('../../public/scripts/popup.js', () => ({ fixToastrForDialogs: jest.fn() }));
await jest.unstable_mockModule('../../public/scripts/sillybunny-action-menu.js', () => ({
    openActionMenu: jest.fn(),
    closeActionMenu: jest.fn(),
    isActionMenuOpen: jest.fn(() => false),
}));
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    animateIn: jest.fn(),
    animateOut: jest.fn(),
    prefersReducedMotion: jest.fn(() => true),
    MOTION_EASE_OUT_QUAD: 'linear',
    MOTION_FAST: 0,
}));

const libRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'lib');
const { classifyToast } = await import('../../public/scripts/sillybunny-toast-form.js');
const { showCompletionToast } = await import('../../public/scripts/sillybunny-home/getting-started-toast.js');
const { flagMissingKey, notifyNotConnected } = await import('../../public/scripts/sillybunny-connection-notices.js');
const { showDraftRecoveryToast } = await import('../../public/scripts/sillybunny-editor/chrome.js');

const KINDS = ['info', 'success', 'warning', 'error'];

/** The options that `public/script.js` sets, without the animation timers. */
const CORE_OPTIONS = {
    positionClass: 'toast-top-center',
    closeButton: false,
    progressBar: false,
    showDuration: 0,
    hideDuration: 0,
    timeOut: 5000,
    extendedTimeOut: 5000,
    showMethod: 'show',
    hideMethod: 'hide',
    escapeHtml: true,
};

/** One line of text is 8px per character, so 68 characters are exactly 34em at 16px. */
const measureByText = element => ({ width: element.textContent.length * 8, em: 16 });
const TOAST_LIMIT_CHARACTERS = 68;

let toastr;
let $;
/** @type {{ kind: string, $toast: any, effective: Record<string, any> }[]} */
let calls = [];

/** Records the toasts that toastr makes, with the effective options of each call, and calls through to toastr. */
function recordToastrCalls() {
    calls = [];
    for (const kind of KINDS) {
        const original = toastr[kind];
        jest.spyOn(toastr, kind).mockImplementation(function (message, title, override) {
            const effective = { ...toastr.options, ...override };
            const $toast = original.call(toastr, message, title, override);
            calls.push({ kind, $toast, effective });
            return $toast;
        });
    }
}

/**
 * @param {string} name What the call is, and where it is from when it comes from code that was read.
 * @param {() => unknown} run Makes the call, written as the caller writes it.
 * @param {'toast'|'notification'} form
 * @param {string} reason
 * @param {(element: HTMLElement) => void} [check] Asserts what the row says about the element toastr built.
 */
const row = (name, run, form, reason, check) => ({ name, run, form, reason, check });

const text = element => element.querySelector('.toast-message')?.textContent;
const noMarkup = element => expect(element.querySelector('.toast-message > *')).toBeNull();

const rows = [
    // Message types
    row('message: a string', () => toastr.info('Settings saved'), 'toast', 'fits'),
    row('message: a string that looks like HTML is text while escapeHtml is true', () => toastr.info('<b>Settings saved</b>'), 'toast', 'fits', noMarkup),
    row('message: escaped text that looks like blocks and buttons is plain text', () => toastr.info('<div>One</div><div>Two</div><button>A</button><button>B</button>'), 'toast', 'fits', noMarkup),
    row('message: angle brackets in escaped text (LorebookOrdering index.js:466)', () => toastr.warning('Usage: /stlo <lorebook name>'), 'toast', 'fits', element => {
        noMarkup(element);
        expect(text(element)).toBe('Usage: /stlo <lorebook name>');
    }),
    row('message: angle brackets in escaped text (the shape of MemoryBooks index.js:1882)', () => toastr.warning('interval=<chunk size> start=<message id> end=<message id>'), 'toast', 'fits', noMarkup),
    row('message: HTML string, escapeHtml false, one line', () => toastr.info('<b>Saved</b> to the book', undefined, { escapeHtml: false }), 'toast', 'fits'),
    row('message: HTML string, one block and one button (the Undo shape)', () => toastr.info('<div>Removed <button type="button">Undo</button></div>', '', { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 }), 'toast', 'fits'),
    row('message: HTML string, two lines', () => toastr.info('One<br>Two', undefined, { escapeHtml: false }), 'notification', 'blocks'),
    row('message: HTML string, two buttons', () => toastr.info('<button>Keep</button><button>Discard</button>', undefined, { escapeHtml: false }), 'notification', 'buttons'),
    row('message: HTML string, two buttons drawn as div.menu_button, as upstream draws them', () => toastr.info('<div class="menu_button">Keep</div><div class="menu_button">Discard</div>', undefined, { escapeHtml: false }), 'notification', 'buttons'),
    row('message: HTML string, one div.menu_button inside a wrapper', () => toastr.info('<div>Removed <div class="menu_button">Undo</div></div>', undefined, { escapeHtml: false }), 'toast', 'fits'),
    row('message: HTML string, text and a link on its own line, untitled', () => toastr.error('Summary failed<br><a href="#" class="stmb-raw-response-link">View the raw response</a>', undefined, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 }), 'notification', 'blocks'),
    row('message: HTML string, a link inside the text', () => toastr.info('Saved to <a href="#">the book</a>', undefined, { escapeHtml: false }), 'toast', 'fits'),
    row('message: an HTMLElement, one block', () => {
        const message = document.createElement('div');
        message.textContent = 'Saved';
        return toastr.info(message, undefined, { escapeHtml: false });
    }, 'toast', 'fits'),
    row('message: an HTMLElement, two blocks', () => {
        const message = document.createElement('div');
        message.innerHTML = '<div>One</div><div>Two</div>';
        return toastr.info(message, undefined, { escapeHtml: false });
    }, 'notification', 'blocks'),
    row('message: an HTMLElement with a Font Awesome icon and text', () => {
        const message = document.createElement('span');
        message.innerHTML = '<i class="fa-solid fa-check"></i> Saved';
        return toastr.success(message, undefined, { escapeHtml: false });
    }, 'toast', 'fits'),
    row('message: a jQuery object, one element', () => toastr.info($('<div>Saved</div>'), undefined, { escapeHtml: false }), 'toast', 'fits'),
    row('message: a jQuery object, two elements', () => toastr.info($('<div>One</div><div>Two</div>'), undefined, { escapeHtml: false }), 'notification', 'blocks'),
    row('message: a jQuery object with text and one button', () => toastr.info($('<span>Removed <button>Undo</button></span>'), undefined, { escapeHtml: false }), 'toast', 'fits'),
    row('message: a number with escapeHtml false', () => toastr.info(42, undefined, { escapeHtml: false }), 'toast', 'fits', element => expect(text(element)).toBe('42')),
    row('message: zero, which toastr treats as no message', () => toastr.info(0, undefined, { escapeHtml: false }), 'toast', 'fits', element => expect(element.querySelector('.toast-message')).toBeNull()),
    row('message: an empty string', () => toastr.info(''), 'toast', 'fits', element => expect(element.querySelector('.toast-message')).toBeNull()),
    row('message: undefined', () => toastr.info(undefined), 'toast', 'fits'),
    row('message: null', () => toastr.info(null), 'toast', 'fits'),
    row('message: no argument', () => toastr.info(), 'toast', 'fits'),
    row('message: only spaces', () => toastr.info('   '), 'toast', 'fits'),

    // Title types
    row('title: a string', () => toastr.info('Saved', 'Done'), 'notification', 'title'),
    row('title: an HTMLElement with text', () => {
        const title = document.createElement('span');
        title.textContent = 'Done';
        return toastr.info('Saved', title, { escapeHtml: false });
    }, 'notification', 'title'),
    row('title: a jQuery object with text', () => toastr.info('Saved', $('<span>Done</span>'), { escapeHtml: false }), 'notification', 'title'),
    row('title: an element with no text', () => toastr.info('Saved', $('<i class="fa-solid fa-check"></i>'), { escapeHtml: false }), 'toast', 'fits'),
    row('title: escaped markup counts as its text', () => toastr.info('Saved', '<b>Done</b>'), 'notification', 'title'),
    row('title: an empty string with options (InjectManager index.js:569)', () => toastr.error('Name already used', '', { timeOut: 3000 }), 'toast', 'fits'),
    row('title: undefined with options (MemoryBooks index.js:12983)', () => toastr.warning('Request failed', undefined, { timeOut: 10000, extendedTimeOut: 1000 }), 'toast', 'fits'),
    row('title: null', () => toastr.info('Saved', null), 'toast', 'fits'),
    row('title: only spaces', () => toastr.info('Saved', '  '), 'toast', 'fits'),
    row('title: no message, only a title (Objective index.js:79)', () => toastr.info(undefined, 'Please wait...'), 'notification', 'title'),
    row('title: only the name of the extension, with a short message (MemoryBooks index.js:1117)', () => toastr.error('Enter a character name and select a Memory Book.', 'STMemoryBooks'), 'notification', 'title'),
    row('title: a debug prefix and a label, with a shared options object (RVC index.js:157)', () => {
        const toastOptions = { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true };
        return toastr.error('Bad Request', '[RVC] RVC Voice Conversion Failed', toastOptions);
    }, 'notification', 'title'),
    row('title: a headline (Prome-VN-Extension modules/slash-commands.js:43)', () => toastr.success('Letterbox mode is now set to bars mode.', 'Letterbox Mode Status'), 'notification', 'title'),
    row('title: a dynamic message with the name of the extension (WebLLM src/index.js:313)', () => toastr.error(`Failed to load model: ${new Error('Out of memory').message}`, 'WebLLM'), 'notification', 'title'),

    // Options
    row('options: a literal', () => toastr.info('Saved', undefined, { timeOut: 3000 }), 'toast', 'fits'),
    row('options: a spread', () => {
        const shared = { extendedTimeOut: 1000, closeButton: false };
        return toastr.info('Saved', undefined, { ...shared, timeOut: 8000 });
    }, 'toast', 'fits'),
    row('options: the template of Blip, RVC, Speech-Recognition and VRM, untitled', () => toastr.info('Voice ready', undefined, { timeOut: 10000, extendedTimeOut: 20000, preventDuplicates: true }), 'toast', 'fits'),
    row('options: none', () => toastr.info('Saved', undefined, undefined), 'toast', 'fits'),
    row('options: an empty object', () => toastr.info('Saved', undefined, {}), 'toast', 'fits'),
    row('options: a progress text that stays, untitled', () => toastr.info('Regenerating memory...', undefined, { timeOut: 0 }), 'toast', 'fits'),
    row('options: a progress text that stays, titled (WebLLM src/index.js:96)', () => toastr.info('Please wait...', 'WebLLM', { timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: false, progressBar: false }), 'notification', 'title'),
    row('options: onclick, untitled', () => toastr.info('Click to review.', undefined, { onclick: () => {} }), 'notification', 'onclick'),
    row('options: onclick and a title (MemoryBooks stmbProgress.js:165)', () => toastr.info('Deferred. Click to review.', 'STMemoryBooks', { onclick: () => {} }), 'notification', 'title'),
    row('options: onclick from a persistent failure (MemoryBooks index.js:10656)', () => toastr.error('Arc failed', undefined, { timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: false, onclick: () => {} }), 'notification', 'onclick'),
    row('options: onclick that is not a function does not count', () => toastr.info('Saved', undefined, { onclick: 'run()' }), 'toast', 'fits'),
    row('options: tapToDismiss false', () => toastr.info('Saved', undefined, { tapToDismiss: false }), 'toast', 'fits'),
    row('options: tapToDismiss true', () => toastr.info('Saved', undefined, { tapToDismiss: true }), 'toast', 'fits'),
    row('options: closeButton', () => toastr.info('Saved', undefined, { closeButton: true }), 'toast', 'fits', element => {
        expect(element.querySelector('.toast-close-button')).not.toBeNull();
    }),
    row('options: a close button that is drawn as a menu button is not a button of the message', () => toastr.info('Saved', undefined, { closeButton: true, closeHtml: '<div class="menu_button">x</div>' }), 'toast', 'fits', element => {
        expect(element.querySelector('.toast-close-button.menu_button')).not.toBeNull();
    }),
    row('options: a progress bar', () => toastr.info('Saved', undefined, { progressBar: true }), 'toast', 'fits', element => {
        expect(element.querySelector('.toast-progress')).not.toBeNull();
    }),
    row('options: preventDuplicates on the first call', () => toastr.info('A message that is shown once', undefined, { preventDuplicates: true }), 'toast', 'fits'),
    row('options: newestOnTop false', () => toastr.info('Saved', undefined, { newestOnTop: false }), 'toast', 'fits'),
    row('options: rtl', () => toastr.info('Saved', undefined, { rtl: true }), 'toast', 'fits', element => {
        expect(element.classList.contains('rtl')).toBe(true);
    }),
    row('options: a custom icon class', () => toastr.info('Saved', undefined, { iconClass: 'toast-custom' }), 'toast', 'fits'),
    row('options: a custom toast class', () => toastr.info('Saved', undefined, { toastClass: 'mine' }), 'toast', 'fits', element => {
        expect(element.classList.contains('mine')).toBe(true);
    }),
    row('options: custom title and message classes are the ones that are read', () => toastr.info('<div>One</div><div>Two</div>', undefined, { messageClass: 'my-message', titleClass: 'my-title', escapeHtml: false }), 'notification', 'blocks'),
    row('options: a custom title class is the one that is read for the title', () => toastr.info('Saved', 'Done', { titleClass: 'my-title' }), 'notification', 'title', element => {
        expect(element.querySelector('.my-title')).not.toBeNull();
        expect(element.querySelector('.toast-title')).toBeNull();
    }),
    row('options: a position, a container and a target on the call (SmartNotify modules/appearance.js:59)', () => toastr.info('Saved', undefined, { positionClass: 'toast-bottom-left', containerId: 'other-container', target: 'body', timeOut: 3000, extendedTimeOut: 1000 }), 'toast', 'fits'),

    // Text length, as the width rule sees it
    row('width: a message of 68 characters, at the limit', () => toastr.info('x'.repeat(TOAST_LIMIT_CHARACTERS)), 'toast', 'fits'),
    row('width: a message of 69 characters', () => toastr.info('x'.repeat(TOAST_LIMIT_CHARACTERS + 1)), 'notification', 'width'),
    row('width: untitled text of 79 characters (ScreenShare index.js:173)', () => toastr.error('Your browser does not support ImageCapture API. Please use a different browser.'), 'notification', 'width', element => {
        expect(text(element).length).toBeGreaterThan(TOAST_LIMIT_CHARACTERS);
    }),
    row('width: untitled text of 170 characters (Guinevere-UI-Extension index.js:94)', () => toastr.info('x'.repeat(170)), 'notification', 'width'),

    // Global options and a changed toast class
    row('global: toastClass swapped to displayNone, untitled (WI-Bulk-Mover index.js:342-346)', () => {
        toastr.options.preventDuplicates = true;
        toastr.options.toastClass = 'displayNone';
        return toastr.info('Core raised this during a bulk move');
    }, 'toast', 'fits', element => {
        expect(element.classList.contains('displayNone')).toBe(true);
        expect(element.classList.contains('toast')).toBe(false);
        expect(element.classList.contains('toast-info')).toBe(true);
    }),
    row('global: toastClass swapped to displayNone, titled (WI-Bulk-Mover index.js:332)', () => {
        toastr.options.toastClass = 'displayNone';
        return toastr.info('Moving 3 entries to the lorebook', 'WI Bulk Mover', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    }, 'notification', 'title', element => {
        expect(element.classList.contains('displayNone')).toBe(true);
    }),
    row('global: toastClass swapped, and one call puts toast back (WI-Bulk-Mover index.js:328)', () => {
        toastr.options.toastClass = 'displayNone';
        return toastr.error('Could not move the entries', undefined, { toastClass: 'toast' });
    }, 'toast', 'fits', element => {
        expect(element.classList.contains('toast')).toBe(true);
        expect(element.classList.contains('displayNone')).toBe(false);
    }),
    row('global: positionClass and newestOnTop written to toastr.options (ToastTome index.js:759)', () => {
        toastr.options.positionClass = 'toast-top-center';
        toastr.options.newestOnTop = true;
        return toastr.info('Saved');
    }, 'toast', 'fits'),
    row('global: toastr.options replaced as a whole', () => {
        toastr.options = { timeOut: 0, extendedTimeOut: 0 };
        return toastr.info('Saved');
    }, 'toast', 'fits'),

    // The /echo command (public/scripts/slash-commands.js:4609)
    row('/echo: a value', () => toastr.info('Hello there', undefined, { escapeHtml: true }), 'toast', 'fits'),
    row('/echo: cssClass replaces the toast class on the element', () => toastr.info('Hello there', undefined, { toastClass: 'my-echo', escapeHtml: true }), 'toast', 'fits', element => {
        expect(element.classList.contains('my-echo')).toBe(true);
        expect(element.classList.contains('toast')).toBe(false);
    }),
    row('/echo: cssClass with a title', () => toastr.warning('Hello there', 'Careful', { toastClass: 'my-echo', escapeHtml: true }), 'notification', 'title'),
    row('/echo: timeout and extendedTimeout', () => toastr.info('Hello there', undefined, { timeOut: 3000, extendedTimeOut: 1000, escapeHtml: true }), 'toast', 'fits'),
    row('/echo: onClick closure', () => toastr.info('Hello there', undefined, { escapeHtml: true, onclick: async () => {} }), 'notification', 'onclick'),
    row('/echo: awaitDismissal sets onHidden', () => toastr.info('Hello there', undefined, { escapeHtml: true, onHidden: () => {} }), 'toast', 'fits'),
    row('/echo: escapeHtml=false with sanitised HTML (WorldInfo-Recommender commands.ts:596)', () => toastr.success('<b>Entry</b> created', undefined, { escapeHtml: false }), 'toast', 'fits'),
    row('/echo: color is applied to the element after the call', () => {
        const $toast = toastr.info('Hello there', undefined, { escapeHtml: true });
        $toast.css('background-color', 'red');
        return $toast;
    }, 'toast', 'fits'),

    // Markup that bundled code and extensions pass
    row('markup: MemoryBooks failure toast as written (index.js:5936)', () => toastr.error(
        'Summary failed<br><a href="#" class="stmb-raw-response-link">View the raw response</a>',
        'STMemoryBooks',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: false, escapeHtml: false },
    ), 'notification', 'title', element => {
        expect(element.querySelector('a.stmb-raw-response-link')).not.toBeNull();
    }),
    row('markup: Slash Command Changes (SlashCommandChanges index.js:57)', () => toastr.info(
        ['<strong>Changed:</strong> /foo', 'Removed: /bar'].join('<br>'),
        'Slash Command Changes',
        { escapeHtml: false, timeOut: 0, onclick: async () => {} },
    ), 'notification', 'title'),
    row('markup: Prompt Editor undo toast, copied from sillybunny-prompt-editor.js:453', () => {
        const body = document.createElement('div');
        body.textContent = 'Prompt moved';
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'menu_button';
        undo.textContent = 'Undo';
        body.append(undo);
        return toastr.info(body, '', { timeOut: 5000, escapeHtml: false, onHidden: () => {} });
    }, 'toast', 'fits', element => {
        expect(element.querySelectorAll('button')).toHaveLength(1);
    }),
    row('markup: Reply lost, copied from server-generations.js:309', () => {
        const content = $('<div></div>').append($('<div></div>').text('The server restarted while a reply for this chat was being written, so the reply was lost.'));
        content.append($('<a href="javascript:void(0)"></a>').text('Regenerate'));
        return toastr.warning(content, 'Reply lost', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true, escapeHtml: false });
    }, 'notification', 'title', element => {
        expect(element.querySelector('a')).not.toBeNull();
    }),
    row('markup: Getting Started step toast (getting-started-toast.js:96)', () => showCompletionToast(
        { kind: 'next', finished: { title: 'Connect a Model' }, next: { title: 'Pick a Preset', target: 'presets' } },
        { toast: toastr, openTarget: jest.fn() },
    ), 'notification', 'title', element => {
        expect(element.querySelectorAll('.toast-message button')).toHaveLength(1);
        expect(element.querySelector('.toast-title').textContent).toBe('Connect a Model');
        // Two lines and one button: without its title the message would be a notification for its blocks.
        expect(element.querySelectorAll('.toast-message > .sbHomeToast > div')).toHaveLength(2);
    }),
    row('markup: Getting Started final toast (getting-started-toast.js:96)', () => showCompletionToast(
        { kind: 'finished' },
        { toast: toastr, openTarget: jest.fn() },
    ), 'notification', 'title', element => {
        expect(element.querySelectorAll('.toast-message button')).toHaveLength(1);
    }),
    row('markup: connection notice, not connected (sillybunny-connection-notices.js:64)', () => notifyNotConnected({ toast: toastr, openTarget: jest.fn() }), 'notification', 'title', element => {
        expect(element.querySelectorAll('.toast-message button.menu_button')).toHaveLength(1);
    }),
    row('markup: connection notice, missing key (sillybunny-connection-notices.js:95)', () => flagMissingKey(null, { toast: toastr }), 'notification', 'title'),
    row('markup: draft recovery with Restore and Discard (sillybunny-editor/chrome.js:539)', () => showDraftRecoveryToast({ ts: 1700000000000 }, { restore: jest.fn(), discard: jest.fn() }), 'notification', 'buttons', element => {
        expect(element.querySelectorAll('.toast-message button.menu_button')).toHaveLength(2);
        expect(element.querySelector('.toast-title')).toBeNull();
    }),
];

beforeAll(() => {
    window.eval(readFileSync(path.join(libRoot, 'jquery-3.5.1.min.js'), 'utf8'));
    window.eval(readFileSync(path.join(libRoot, 'toastr.min.js'), 'utf8'));
    toastr = window.toastr;
    $ = window.jQuery;
});

beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
    toastr.options = { ...CORE_OPTIONS };
    recordToastrCalls();
});

afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
});

describe('every input pattern gets one form and nothing throws', () => {
    test.each(rows)('$name', ({ run, form, reason, check }) => {
        const warn = jest.spyOn(console, 'warn');
        let outcome;
        expect(() => {
            run();
            const { $toast, effective } = calls.at(-1);
            outcome = { element: $toast[0], result: classifyToast($toast[0], effective, { measure: measureByText }) };
        }).not.toThrow();

        expect(outcome.result).toEqual({ form, reason });
        expect(warn).not.toHaveBeenCalled();
        check?.(outcome.element);
    });

    test('the table has a row for every input type that the plan lists', () => {
        const names = rows.map(entry => entry.name);
        const listed = [
            'message: a string', 'message: an HTMLElement', 'message: a jQuery object', 'message: a number', 'message: an empty string', 'message: undefined',
            'title: a string', 'title: an HTMLElement', 'title: a jQuery object', 'title: an empty string', 'title: undefined',
            'options: a literal', 'options: a spread', 'options: none',
        ];
        for (const prefix of listed) {
            expect(names.some(name => name.startsWith(prefix))).toBe(true);
        }
    });
});

describe('the kind of the toast does not change the form', () => {
    const messages = [
        ['an untitled plain message', ['Settings saved'], 'toast'],
        ['a titled message', ['Settings saved', 'Done'], 'notification'],
        ['a message of two lines', ['One<br>Two', undefined, { escapeHtml: false }], 'notification'],
    ];

    test.each(KINDS.flatMap(kind => messages.map(([name, args, form]) => [kind, name, args, form])))('%s: %s', (kind, name, args, form) => {
        toastr[kind](...args);
        const { $toast, effective } = calls.at(-1);
        expect(classifyToast($toast[0], effective, { measure: measureByText }).form).toBe(form);
    });

    test('a kind chosen by name, as `toastr[type](message, title)` does', () => {
        const type = 'warning';
        toastr[type]('Settings saved');
        const { $toast, effective } = calls.at(-1);
        expect(classifyToast($toast[0], effective, { measure: measureByText })).toEqual({ form: 'toast', reason: 'fits' });
    });
});

describe('a call that toastr does not turn into a toast', () => {
    test('preventDuplicates: the repeat returns undefined, so there is nothing to classify', () => {
        const options = { preventDuplicates: true };
        const first = toastr.info('Shown once only', undefined, options);
        const repeat = toastr.info('Shown once only', undefined, options);

        expect(classifyToast(first[0], { ...toastr.options, ...options }, { measure: measureByText })).toEqual({ form: 'toast', reason: 'fits' });
        expect(repeat).toBeUndefined();
        expect(document.querySelectorAll('#toast-container > *')).toHaveLength(1);
    });

    test('a number is not escaped by toastr, so toastr itself throws for it while escapeHtml is true', () => {
        // This is toastr's behaviour. The classifier only sees what toastr built, and the row above uses escapeHtml false.
        expect(() => toastr.info(42)).toThrow(TypeError);
    });
});

describe('the fallback', () => {
    test('a toast that cannot be classified becomes a notification, never an error', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        toastr.info('Settings saved');
        const { $toast, effective } = calls.at(-1);
        const failing = () => {
            throw new Error('no layout');
        };
        expect(classifyToast($toast[0], effective, { measure: failing })).toEqual({ form: 'notification', reason: 'error' });
        // This is the only test of the file that makes the classifier fail, so it logs the one warning of the session.
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
