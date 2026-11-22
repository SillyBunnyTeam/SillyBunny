/**
 * @jest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The real jQuery and the real toastr build the elements, so the classifier is tested against what toastr renders.
const libRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'lib');

let toastr;
let form;

/** One line of text is 8px per character, so 68 characters are exactly 34em at 16px. */
const measureByText = element => ({ width: element.textContent.length * 8, em: 16 });
/** No injected measure: the classifier uses its own browser measure. */
const browserMeasure = {};
const measureNothing = () => {
    throw new Error('A rule that comes before the width rule must decide without a measurement.');
};

const BASE_OPTIONS = {
    showMethod: 'show',
    hideMethod: 'hide',
    timeOut: 0,
    extendedTimeOut: 0,
    escapeHtml: true,
    tapToDismiss: true,
    closeButton: false,
};

/**
 * Creates a toast through toastr and classifies the element it returns, the way the queue does.
 * @returns {{ element: HTMLElement, result: { form: string, reason: string } }}
 */
function classified(message, title, override, dependencies = { measure: measureByText }) {
    const $toast = toastr.info(message, title, override);
    const element = $toast[0];
    return { element, result: form.classifyToast(element, { ...toastr.options, ...override }, dependencies) };
}

beforeAll(async () => {
    window.eval(readFileSync(path.join(libRoot, 'jquery-3.5.1.min.js'), 'utf8'));
    window.eval(readFileSync(path.join(libRoot, 'toastr.min.js'), 'utf8'));
    toastr = window.toastr;
    form = await import('../../public/scripts/sillybunny-toast-form.js');
});

afterEach(() => {
    toastr.options = { ...BASE_OPTIONS };
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('failure', () => {
    // The warning is logged once per page session, so this is the first test in the file to make the classifier fail.
    test('a measure that throws gives a notification, and one warning across two calls', () => {
        toastr.options = { ...BASE_OPTIONS };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const failing = () => {
            throw new Error('layout is gone');
        };

        const first = classified('A plain message', undefined, undefined, { measure: failing });
        const second = classified('Another plain message', undefined, undefined, { measure: failing });

        expect(first.result).toEqual({ form: 'notification', reason: 'error' });
        expect(second.result).toEqual({ form: 'notification', reason: 'error' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0].join(' '))).toContain('layout is gone');
    });

    test('an input that is not an element gives a notification and never throws', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        for (const input of [null, undefined, {}, 'text', 5]) {
            expect(form.classifyToast(input, {}, { measure: measureNothing })).toEqual({ form: 'notification', reason: 'error' });
        }
    });

    test('missing options and missing dependencies are accepted', () => {
        toastr.options = { ...BASE_OPTIONS };
        const element = toastr.info('Saved')[0];
        expect(form.classifyToast(element, undefined, { measure: measureByText })).toEqual({ form: 'toast', reason: 'fits' });
        expect(form.classifyToast(element, null, { measure: measureByText })).toEqual({ form: 'toast', reason: 'fits' });
    });
});

describe('names', () => {
    test('the forms, marker classes and limits are the fixed ones', () => {
        expect(form.TOAST_FORM).toBe('toast');
        expect(form.NOTIFICATION_FORM).toBe('notification');
        expect(form.TOAST_FORM_CLASS).toBe('sb-form-toast');
        expect(form.NOTIFICATION_FORM_CLASS).toBe('sb-form-notification');
        expect(form.TOAST_OVERLAY_ID).toBe('sb-toast-overlay');
        expect(form.TOAST_MAX_WIDTH_EM).toBe(34);
        expect(form.NOTIFICATION_MAX_SHOWN).toBe(3);
        expect(form.NOTIFICATION_TIMEOUT).toBe(4000);
    });
});

describe('rule 1: title', () => {
    test('a title with text makes a notification, with or without a message', () => {
        expect(classified('Saved', 'Done').result).toEqual({ form: 'notification', reason: 'title' });
        expect(classified(undefined, 'Done').result).toEqual({ form: 'notification', reason: 'title' });
    });

    test('a title that holds only spaces, or nothing, does not count', () => {
        expect(classified('Saved', '   ').result).toEqual({ form: 'toast', reason: 'fits' });
        expect(classified('Saved', '').result).toEqual({ form: 'toast', reason: 'fits' });
        expect(classified('Saved', undefined).result).toEqual({ form: 'toast', reason: 'fits' });
    });

    test('a title that is escaped markup counts as its text', () => {
        expect(classified('Saved', '<b></b>').result.reason).toBe('title');
    });

    test('an element title with text counts, and one with no text does not', () => {
        const withText = document.createElement('span');
        withText.textContent = 'Done';
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-check';
        expect(classified('Saved', withText, { escapeHtml: false }).result.reason).toBe('title');
        expect(classified('Saved', icon, { escapeHtml: false }).result.reason).toBe('fits');
    });

    test('decides without a measurement', () => {
        expect(classified('Saved', 'Done', undefined, { measure: measureNothing }).result.reason).toBe('title');
    });
});

describe('rule 2: onclick', () => {
    test('a function makes a notification', () => {
        expect(classified('Saved', undefined, { onclick: () => {} }).result).toEqual({ form: 'notification', reason: 'onclick' });
    });

    test('a value that is not a function does not', () => {
        expect(classified('Saved', undefined, { onclick: true }).result.reason).toBe('fits');
        expect(classified('Saved', undefined, { onclick: null }).result.reason).toBe('fits');
        expect(classified('Saved', undefined, { onclick: 'run()' }).result.reason).toBe('fits');
    });

    test('decides without a measurement', () => {
        expect(classified('Saved', undefined, { onclick: () => {} }, { measure: measureNothing }).result.reason).toBe('onclick');
    });
});

/** Builds a message element from markup, as toastr does for an unescaped message. */
function messageOf(markup) {
    const message = document.createElement('div');
    message.className = 'toast-message';
    message.innerHTML = markup;
    return message;
}

describe('rule 3: buttons', () => {
    const html = { escapeHtml: false };

    test('more than one button makes a notification', () => {
        expect(classified('<button>Keep</button><button>Discard</button>', undefined, html).result).toEqual({ form: 'notification', reason: 'buttons' });
    });

    test('one button stays a toast', () => {
        expect(classified('Removed <button type="button">Undo</button>', undefined, html).result).toEqual({ form: 'toast', reason: 'fits' });
        expect(classified('<div>Removed <button type="button">Undo</button></div>', undefined, html).result).toEqual({ form: 'toast', reason: 'fits' });
    });

    test('a button counts in every form the app and its extensions draw one', () => {
        const buttons = [
            '<button>A</button>',
            '<div role="button" tabindex="0">A</div>',
            '<input type="button" value="A">',
            '<input type="submit" value="A">',
            '<input type="reset" value="A">',
            '<div class="menu_button">A</div>',
        ];
        for (const button of buttons) {
            expect(classified(`${button}${button}`, undefined, html).result.reason).toBe('buttons');
        }
    });

    test('different forms of button add up', () => {
        expect(classified('<button>A</button><div class="menu_button">B</div>', undefined, html).result.reason).toBe('buttons');
    });

    test('a button nested in another button counts once', () => {
        expect(form.countButtons(messageOf('<div class="menu_button"><button>A</button></div>'))).toBe(1);
        expect(form.countButtons(messageOf('<div class="menu_button"><span role="button"><input type="button"></span></div>'))).toBe(1);
        expect(classified('<div class="menu_button"><button>A</button></div>', undefined, html).result.reason).toBe('fits');
    });

    test('sibling buttons inside one wrapper each count', () => {
        expect(form.countButtons(messageOf('<div><div class="menu_button">A</div><div class="menu_button">B</div></div>'))).toBe(2);
    });

    test('the close button that toastr adds is not a button of the message', () => {
        const { element, result } = classified('Saved', undefined, { closeButton: true });
        expect(element.querySelector('.toast-close-button')).not.toBeNull();
        expect(result.reason).toBe('fits');
    });

    test('inputs of other types are not buttons', () => {
        expect(form.countButtons(messageOf('<input type="text"><input type="checkbox">'))).toBe(0);
    });

    test('decides without a measurement', () => {
        const markup = '<button>A</button><button>B</button>';
        expect(classified(markup, undefined, html, { measure: measureNothing }).result.reason).toBe('buttons');
    });
});

describe('rule 4: blocks', () => {
    const blocksIn = markup => form.countBlocks(messageOf(markup));

    test('more than one block makes a notification', () => {
        expect(classified('<div>Well done.</div><div>Next is Start Chatting.</div>', undefined, { escapeHtml: false }).result).toEqual({ form: 'notification', reason: 'blocks' });
        expect(classified('One<br>Two', undefined, { escapeHtml: false }).result.reason).toBe('blocks');
    });

    test('one block stays a toast', () => {
        expect(classified('<div>Well done.</div>', undefined, { escapeHtml: false }).result.reason).toBe('fits');
    });

    test('text and inline elements are one block until a break or a block element ends it', () => {
        expect(blocksIn('Saved <b>now</b> to <a href="#">the book</a>, <code>ok</code>')).toBe(1);
        expect(blocksIn('A<br>B')).toBe(2);
        expect(blocksIn('A<br><br>B<br>C')).toBe(3);
        expect(blocksIn('A <b>bold</b><br>B')).toBe(2);
        expect(blocksIn('<span>A<br>B</span>')).toBe(2);
        expect(blocksIn('A<div>B</div>C')).toBe(3);
    });

    test('a break at the end, and empty or blank content, add no block', () => {
        expect(blocksIn('A<br>')).toBe(1);
        expect(blocksIn('<br>')).toBe(0);
        expect(blocksIn('')).toBe(0);
        expect(blocksIn('  \n  ')).toBe(0);
        expect(blocksIn('<div> </div><div></div>')).toBe(0);
    });

    test('a failure message with a link on its own line is two blocks (the MemoryBooks pattern)', () => {
        expect(blocksIn('Summary failed<br><a href="#" class="stmb-raw-response-link">View the raw response</a>')).toBe(2);
    });

    test('a wrapper that holds one block is looked through', () => {
        expect(blocksIn('<div><div>A</div></div>')).toBe(1);
        expect(blocksIn('<div><div><p>A</p></div></div>')).toBe(1);
        expect(blocksIn('<div><div>A</div><div>B</div></div>')).toBe(2);
        expect(blocksIn('<div><div><div>A</div><div>B</div></div><button>Undo</button></div>')).toBe(2);
        expect(blocksIn('<div>Title<div>Body</div></div>')).toBe(2);
    });

    test('block elements of every common kind end a run', () => {
        expect(blocksIn('<p>A</p><p>B</p>')).toBe(2);
        expect(blocksIn('<h4>A</h4><pre>B</pre>')).toBe(2);
        expect(blocksIn('<blockquote>A</blockquote><div>B</div>')).toBe(2);
    });

    test('buttons are not blocks and do not end a run', () => {
        expect(blocksIn('<button>Undo</button>')).toBe(0);
        expect(blocksIn('<div class="menu_button">Undo</div>')).toBe(0);
        expect(blocksIn('Removed <button>Undo</button>')).toBe(1);
        expect(blocksIn('Removed <button>Undo</button> now')).toBe(1);
        expect(blocksIn('<div>Removed</div><div><button>Undo</button><button>Redo</button></div>')).toBe(1);
        expect(blocksIn('<div><div>Removed</div><button>Undo</button></div>')).toBe(1);
        expect(blocksIn('<div class="menu_button"><span>Label</span><div>Hint</div></div>')).toBe(0);
    });

    test('a Font Awesome icon is inline and adds no block', () => {
        expect(blocksIn('<i class="fa-solid fa-check"></i> Saved')).toBe(1);
        expect(blocksIn('<i class="fa-solid fa-check"></i>')).toBe(0);
        expect(blocksIn('<span><i class="fa-solid fa-check"></i></span> Saved')).toBe(1);
    });

    test('media, tables, form fields and rules count as one block each, with or without text', () => {
        const alone = [
            '<img src="a.png">',
            '<picture><img src="a.png"></picture>',
            '<video></video>',
            '<audio></audio>',
            '<canvas></canvas>',
            '<svg viewBox="0 0 1 1"></svg>',
            '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>',
            '<table></table>',
            '<input type="text">',
            '<input type="checkbox">',
            '<select><option>A</option></select>',
            '<textarea></textarea>',
            '<progress></progress>',
            '<meter></meter>',
            '<hr>',
        ];
        for (const markup of alone) {
            expect(blocksIn(markup)).toBe(1);
            expect(blocksIn(`Saved${markup}`)).toBe(2);
        }
    });

    test('an input that is hidden or a button draws nothing, so it is no block', () => {
        expect(blocksIn('<input type="hidden" value="x">')).toBe(0);
        expect(blocksIn('<input type="submit" value="Go">')).toBe(0);
    });

    test('an svg inside an inline wrapper is an icon, and one outside is a block', () => {
        expect(blocksIn('<span class="icon"><svg viewBox="0 0 1 1"></svg></span> Saved')).toBe(1);
        expect(blocksIn('<i><svg viewBox="0 0 1 1"></svg></i>')).toBe(0);
        expect(blocksIn('<div><svg viewBox="0 0 1 1"></svg> Saved</div>')).toBe(2);
    });

    test('each item of a list with text is a block, and an empty list holds none', () => {
        expect(blocksIn('<ul><li>A</li><li>B</li><li>C</li></ul>')).toBe(3);
        expect(blocksIn('<ol><li>A</li></ol>')).toBe(1);
        expect(blocksIn('<ul><li></li><li> </li></ul>')).toBe(0);
        expect(blocksIn('<ul></ul>')).toBe(0);
        expect(blocksIn('<ul><li>A<ul><li>B</li></ul></li></ul>')).toBe(2);
    });

    test('content that is not drawn is not counted', () => {
        expect(blocksIn('<style>.a { color: red }</style>Saved')).toBe(1);
        expect(blocksIn('<script>run()</script>Saved')).toBe(1);
        expect(blocksIn('<template><div>A</div></template>Saved')).toBe(1);
        expect(blocksIn('<!-- note -->Saved')).toBe(1);
    });

    test('an element that was built in another document is counted like any other', () => {
        const frame = document.createElement('iframe');
        document.body.append(frame);
        const message = frame.contentDocument.createElement('div');
        message.innerHTML = '<div>One</div><div>Two</div><button>A</button>';
        expect(form.countBlocks(message)).toBe(2);
        expect(form.countButtons(message)).toBe(1);
    });

    test('an element the browser does not know is inline', () => {
        expect(blocksIn('<my-tag>A</my-tag><my-tag>B</my-tag>')).toBe(1);
    });

    test('decides without a measurement', () => {
        expect(classified('<div>A</div><div>B</div>', undefined, { escapeHtml: false }, { measure: measureNothing }).result.reason).toBe('blocks');
    });
});

describe('rule 5: width', () => {
    const measured = (width, em = 16) => ({ measure: () => ({ width, em }) });

    test('a message just under 34em is a toast and one just over is a notification', () => {
        expect(classified('Saved', undefined, undefined, measured(34 * 16 - 1)).result).toEqual({ form: 'toast', reason: 'fits' });
        expect(classified('Saved', undefined, undefined, measured(34 * 16 + 1)).result).toEqual({ form: 'notification', reason: 'width' });
    });

    test('half a pixel over the limit is still a toast, and more than that is not', () => {
        expect(classified('Saved', undefined, undefined, measured(34 * 16 + 0.5)).result.reason).toBe('fits');
        expect(classified('Saved', undefined, undefined, measured(34 * 16 + 0.51)).result.reason).toBe('width');
    });

    test('the limit follows the font size of the toast', () => {
        expect(classified('Saved', undefined, undefined, measured(700, 20)).result.reason).toBe('width');
        expect(classified('Saved', undefined, undefined, measured(700, 21)).result.reason).toBe('fits');
        expect(classified('Saved', undefined, undefined, measured(500, 14)).result.reason).toBe('width');
    });

    test('the measure gets the element that toastr returned', () => {
        const measure = jest.fn(() => ({ width: 10, em: 16 }));
        const { element } = classified('Saved', undefined, undefined, { measure });
        expect(measure).toHaveBeenCalledTimes(1);
        expect(measure).toHaveBeenCalledWith(element);
    });

    test('a toast that cannot be measured stays a toast', () => {
        expect(classified('Saved', undefined, undefined, measured(0, NaN)).result.reason).toBe('fits');
    });

    test('the text decides, through a measure that counts characters', () => {
        expect(classified('x'.repeat(68)).result.reason).toBe('fits');
        expect(classified('x'.repeat(69)).result.reason).toBe('width');
    });

    describe('independent of the window', () => {
        function trackWindowWidthReads() {
            const reads = [];
            const track = (target, name) => {
                const original = Object.getOwnPropertyDescriptor(target, name);
                Object.defineProperty(target, name, {
                    configurable: true,
                    get() {
                        reads.push(name);
                        return 1024;
                    },
                });
                return () => (original ? Object.defineProperty(target, name, original) : delete target[name]);
            };
            const restores = [track(window, 'innerWidth'), track(document.documentElement, 'clientWidth')];
            return { reads, restore: () => restores.forEach(restore => restore()) };
        }

        test('the same message gets the same form with a window of 320px and of 2560px', () => {
            const original = window.innerWidth;
            const outcomes = [];
            for (const innerWidth of [320, 2560]) {
                window.innerWidth = innerWidth;
                outcomes.push([
                    classified('x'.repeat(68)).result,
                    classified('x'.repeat(69)).result,
                    classified('x'.repeat(10), undefined, undefined, browserMeasure).result,
                ]);
            }
            window.innerWidth = original;
            expect(outcomes[0]).toEqual(outcomes[1]);
            expect(outcomes[0].map(result => result.reason)).toEqual(['fits', 'width', 'fits']);
        });

        test('neither the injected measure nor the browser measure reads the width of the window', () => {
            const tracker = trackWindowWidthReads();
            try {
                classified('x'.repeat(10));
                classified('x'.repeat(10), undefined, undefined, browserMeasure);
                expect(tracker.reads).toEqual([]);
            } finally {
                tracker.restore();
            }
        });
    });
});

describe('the browser measure', () => {
    /** Runs `action` and returns every node that was added to the document while it ran. */
    function addedNodesDuring(action) {
        const observer = new MutationObserver(() => {});
        observer.observe(document.body, { childList: true, subtree: true });
        try {
            action();
            return observer.takeRecords().flatMap(record => [...record.addedNodes].map(node => ({ node, parent: record.target })));
        } finally {
            observer.disconnect();
        }
    }

    const measuring = () => document.querySelectorAll(`.${form.TOAST_MEASURE_CLASS}`);

    test('runs in jsdom without throwing and leaves no clone behind', () => {
        const { result } = classified('Saved', undefined, undefined, browserMeasure);
        expect(result).toEqual({ form: 'toast', reason: 'fits' });
        expect(measuring()).toHaveLength(0);
    });

    test('measures a clone and never the toast itself', () => {
        const toast = toastr.info('Saved')[0];
        const toastClasses = toast.className;
        const added = addedNodesDuring(() => form.classifyToast(toast, toastr.options));

        expect(added).toHaveLength(1);
        const clone = added[0].node;
        expect(clone).not.toBe(toast);
        expect(clone.classList.contains(form.TOAST_FORM_CLASS)).toBe(true);
        expect(clone.classList.contains(form.TOAST_MEASURE_CLASS)).toBe(true);
        expect(toast.className).toBe(toastClasses);
        expect(toast.isConnected).toBe(true);
    });

    test('puts the clone in the toast overlay when there is one, and in the body when there is not', () => {
        const toast = toastr.info('Saved')[0];
        const withoutOverlay = addedNodesDuring(() => form.classifyToast(toast, toastr.options));
        expect(withoutOverlay[0].parent).toBe(document.body);

        const overlay = document.createElement('div');
        overlay.id = 'sb-toast-overlay';
        document.body.append(overlay);
        const withOverlay = addedNodesDuring(() => form.classifyToast(toast, toastr.options));
        expect(withOverlay[0].parent).toBe(overlay);
        expect(overlay.children).toHaveLength(0);
    });

    // Each message is one block, so the classifier reaches the width rule and measures a clone.
    test.each([
        ['a video', '<video id="inner" autoplay></video>'],
        ['an audio element', '<audio id="inner" autoplay></audio>'],
        ['a frame', '<span id="inner">Saved</span><iframe id="frame" src="about:blank"></iframe>'],
    ])('a clone of %s has no ids and no media or frames, so measuring starts nothing', (name, markup) => {
        const toast = toastr.info(markup, undefined, { escapeHtml: false })[0];
        toast.id = 'toast-id';
        const [{ node: clone }] = addedNodesDuring(() => form.classifyToast(toast, { ...toastr.options, escapeHtml: false }));
        expect(clone.id).toBe('');
        expect(clone.querySelectorAll('[id]')).toHaveLength(0);
        expect(clone.querySelector('video, audio, iframe')).toBeNull();
        expect(toast.querySelector('video, audio, iframe')).not.toBeNull();
        expect(toast.querySelector('#inner')).not.toBeNull();
        expect(toast.id).toBe('toast-id');
    });

    describe('a clone repeats nothing that the message does', () => {
        const IMAGE = '<img id="picture" src="http://localhost/a.png" srcset="http://localhost/a.png 1x, http://localhost/b.png 2x" onerror="window.__errors += 1" onload="window.__errors += 1">';

        const eventAttributesOf = root => [root, ...root.querySelectorAll('*')]
            .flatMap(node => [...node.attributes].map(attribute => attribute.name))
            .filter(name => name.startsWith('on'));

        function cloneOf(markup) {
            const toast = toastr.info(markup, undefined, { escapeHtml: false })[0];
            const [{ node: clone }] = addedNodesDuring(() => form.classifyToast(toast, { ...toastr.options, escapeHtml: false }));
            return { toast, clone };
        }

        test('has no on* attribute, on the clone or in it, and the toast keeps its own', () => {
            const { toast, clone } = cloneOf(`<span onclick="window.__errors += 1" onmouseover="window.__errors += 1">${IMAGE}</span>`);
            expect(eventAttributesOf(clone)).toEqual([]);
            expect(eventAttributesOf(toast)).toEqual(['onclick', 'onmouseover', 'onerror', 'onload']);
            expect(clone.querySelector('.toast-message > span')).not.toBeNull();
        });

        test('does not run the handler of an image a second time when the image fails or loads', () => {
            window.__errors = 0;
            const toast = toastr.info(IMAGE, undefined, { escapeHtml: false })[0];
            jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
                if (this.classList.contains(form.TOAST_MEASURE_CLASS)) {
                    const image = this.querySelector('img');
                    image.dispatchEvent(new Event('error'));
                    image.dispatchEvent(new Event('load'));
                }
                return { width: 1 };
            });
            form.classifyToast(toast, { ...toastr.options, escapeHtml: false });
            expect(window.__errors).toBe(0);
            toast.querySelector('img').dispatchEvent(new Event('error'));
            expect(window.__errors).toBe(1);
        });

        test('loads no image: src and srcset are gone from img and source, and the elements stay', () => {
            const { toast, clone } = cloneOf('<picture><source srcset="http://localhost/a.webp" type="image/webp"><img src="http://localhost/a.png" srcset="http://localhost/a.png 1x" alt="A"></picture>');
            expect(clone.querySelector('picture')).not.toBeNull();
            expect(clone.querySelectorAll('source, img')).toHaveLength(2);
            for (const node of clone.querySelectorAll('source, img')) {
                expect(node.hasAttribute('src')).toBe(false);
                expect(node.hasAttribute('srcset')).toBe(false);
            }
            expect(toast.querySelector('img').getAttribute('src')).toBe('http://localhost/a.png');
            expect(toast.querySelector('source').getAttribute('srcset')).toBe('http://localhost/a.webp');
        });

        test('still counts an image as a block, because the structure is the same', () => {
            expect(classified(`${IMAGE}<div>Text</div>`, undefined, { escapeHtml: false }).result.reason).toBe('blocks');
        });
    });

    test('a toast that is hidden or moving is measured without its inline style, and the toast keeps it', () => {
        const toast = toastr.info('Saved')[0];
        toast.style.display = 'none';
        toast.style.transform = 'translateY(10px)';
        const [{ node: clone }] = addedNodesDuring(() => form.classifyToast(toast, toastr.options));
        expect(clone.hasAttribute('style')).toBe(false);
        expect(toast.style.display).toBe('none');
        expect(toast.style.transform).toBe('translateY(10px)');
    });

    test('removes the clone when reading the layout fails, and the result is a notification', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const toast = toastr.info('Saved')[0];
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => {
            throw new Error('no layout');
        });
        const result = form.classifyToast(toast, toastr.options);
        expect(result).toEqual({ form: 'notification', reason: 'error' });
        expect(measuring()).toHaveLength(0);
    });

    test('reads the width and the font size of the clone', () => {
        const toast = toastr.info('Saved')[0];
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return { width: this.classList.contains(form.TOAST_MEASURE_CLASS) ? 600 : 1 };
        });
        const originalComputedStyle = window.getComputedStyle;
        jest.spyOn(window, 'getComputedStyle').mockImplementation(node => (
            node.classList.contains(form.TOAST_MEASURE_CLASS) ? { fontSize: '16px' } : originalComputedStyle(node)
        ));
        expect(form.classifyToast(toast, toastr.options)).toEqual({ form: 'notification', reason: 'width' });
        window.getComputedStyle.mockImplementation(node => (
            node.classList.contains(form.TOAST_MEASURE_CLASS) ? { fontSize: '20px' } : originalComputedStyle(node)
        ));
        expect(form.classifyToast(toast, toastr.options)).toEqual({ form: 'toast', reason: 'fits' });
    });
});

describe('the browser measure in a surface that is scaled', () => {
    function measureWith({ box, style }) {
        // Each call spies on the real functions again, and not on the spies of the call before.
        jest.restoreAllMocks();
        const toast = toastr.info('Saved')[0];
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
            return { width: this.classList.contains(form.TOAST_MEASURE_CLASS) ? box : 1 };
        });
        const originalComputedStyle = window.getComputedStyle;
        jest.spyOn(window, 'getComputedStyle').mockImplementation(node => (
            node.classList.contains(form.TOAST_MEASURE_CLASS) ? { fontSize: '16px', ...style } : originalComputedStyle(node)
        ));
        return form.classifyToast(toast, toastr.options);
    }

    test('takes the width of the layout, not the box that an ancestor\'s transform scaled', () => {
        // A Popup that opens scales to 0.8: 560px of layout is drawn as 448px, and 34em is 544px.
        expect(measureWith({ box: 448, style: { width: '560px', boxSizing: 'border-box' } })).toEqual({ form: 'notification', reason: 'width' });
        expect(measureWith({ box: 520, style: { width: '520px', boxSizing: 'border-box' } })).toEqual({ form: 'toast', reason: 'fits' });
    });

    test('is not misled the other way, by a surface that is scaled up', () => {
        expect(measureWith({ box: 600, style: { width: '500px', boxSizing: 'border-box' } })).toEqual({ form: 'toast', reason: 'fits' });
    });

    test('adds the padding and the border to a width that is the width of the content', () => {
        // 34em is 544px. 530px of content with 18px of padding is 548px, and 520px with 18px is 538px.
        const style = { boxSizing: 'content-box', paddingLeft: '12px', paddingRight: '6px', borderLeftWidth: '0px', borderRightWidth: '0px' };
        expect(measureWith({ box: 100, style: { ...style, width: '530px' } })).toEqual({ form: 'notification', reason: 'width' });
        expect(measureWith({ box: 100, style: { ...style, width: '520px' } })).toEqual({ form: 'toast', reason: 'fits' });
        expect(measureWith({ box: 100, style: { ...style, width: '530px', paddingLeft: '4px', paddingRight: '4px' } })).toEqual({ form: 'toast', reason: 'fits' });
    });

    test('falls back to the box where the layout gives no width, as in jsdom', () => {
        expect(measureWith({ box: 600, style: { width: 'auto' } })).toEqual({ form: 'notification', reason: 'width' });
        expect(measureWith({ box: 100, style: { width: '' } })).toEqual({ form: 'toast', reason: 'fits' });
    });
});

describe('toastr class options', () => {
    test('a title and a message class set by the caller are the ones that are read', () => {
        const options = { titleClass: 'my-title', messageClass: 'my-message', escapeHtml: false };
        const blocks = classified('<div>One</div><div>Two</div>', undefined, options);
        expect(blocks.element.querySelector('.my-message')).not.toBeNull();
        expect(blocks.result.reason).toBe('blocks');
        expect(classified('Saved', 'Done', options).result.reason).toBe('title');
    });

    test('several classes in one option are all required', () => {
        const options = { titleClass: 'a b', messageClass: 'c d', escapeHtml: false };
        expect(classified('<div>One</div><div>Two</div>', 'Done', options).result.reason).toBe('title');
        expect(classified('<div>One</div><div>Two</div>', undefined, options).result.reason).toBe('blocks');
    });

    test('an empty class option reads nothing and does not throw', () => {
        const options = { titleClass: '', messageClass: '  ' };
        expect(classified('Saved', 'Done', options).result.reason).toBe('fits');
    });
});

describe('rule 6: fits', () => {
    test('an untitled plain message with no click action is a toast', () => {
        expect(classified('Saved').result).toEqual({ form: 'toast', reason: 'fits' });
    });

    test('a toast with a close button, a progress bar and a custom class is still a toast', () => {
        const { result, element } = classified('Saved', undefined, { closeButton: true, progressBar: true, toastClass: 'mine' });
        expect(result).toEqual({ form: 'toast', reason: 'fits' });
        expect(element.querySelector('.toast-close-button')).not.toBeNull();
    });
});

describe('order of the rules', () => {
    test('title wins over onclick, buttons, blocks and width', () => {
        const html = '<div>One</div><div>Two</div><button>A</button><button>B</button>';
        const { result } = classified(html, 'Title', { escapeHtml: false, onclick: () => {} });
        expect(result.reason).toBe('title');
    });

    test('onclick wins over buttons, blocks and width', () => {
        const html = '<div>One</div><div>Two</div><button>A</button><button>B</button>';
        const { result } = classified(html, undefined, { escapeHtml: false, onclick: () => {} });
        expect(result.reason).toBe('onclick');
    });

    test('buttons win over blocks and width', () => {
        const html = '<div>One</div><div>Two</div><button>A</button><button>B</button>';
        const { result } = classified(html, undefined, { escapeHtml: false });
        expect(result.reason).toBe('buttons');
    });

    test('blocks win over width', () => {
        const html = `<div>${'x'.repeat(200)}</div><div>Two</div>`;
        const { result } = classified(html, undefined, { escapeHtml: false });
        expect(result.reason).toBe('blocks');
    });
});
