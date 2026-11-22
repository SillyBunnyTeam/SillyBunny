/**
 * @jest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The queue hooks toastr.subscribe once per page, so the case that toastr's options never arrive has a file of its own.
const libRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'lib');

let toastr;
let toastQueue;
let toastForm;
let subscribeBeforeTheQueue;

beforeAll(async () => {
    window.matchMedia = () => ({ matches: true });
    window.eval(readFileSync(path.join(libRoot, 'jquery-3.5.1.min.js'), 'utf8'));
    window.eval(readFileSync(path.join(libRoot, 'toastr.min.js'), 'utf8'));
    toastr = window.toastr;
    subscribeBeforeTheQueue = toastr.subscribe;
    toastQueue = await import('../../public/scripts/sillybunny-toast-motion.js');
    toastForm = await import('../../public/scripts/sillybunny-toast-form.js');
    toastQueue.initializeToastMotion({ jQuery: window.jQuery, toastr });
    toastr.options = { positionClass: 'toast-top-center', timeOut: 5000, extendedTimeOut: 5000, escapeHtml: true };
});

afterEach(() => {
    toastr.clear(undefined, { force: true });
    toastr.remove();
    document.body.innerHTML = '';
});

describe('when toastr does not hand its options over', () => {
    test('the first message is shown as an in-app notification in #toast-container, and the queue switches off', () => {
        // An extension that holds toastr's own subscribe replaces the listener of the queue.
        subscribeBeforeTheQueue(() => {});
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const first = toastr.info('first message');
        const second = toastr.info('second message', 'Title');
        const third = toastr.success('third message');

        for (const $toast of [first, second, third]) {
            expect($toast.jquery).toBeTruthy();
            expect($toast.closest('#toast-container').length).toBe(1);
            expect($toast[0].style.display).not.toBe('none');
            expect($toast[0].classList.contains(toastForm.NOTIFICATION_FORM_CLASS)).toBe(true);
        }
        expect(document.querySelectorAll('.toast').length).toBe(3);
        expect(document.getElementById('sb-toast-overlay')).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    test('a position or container id that the call sets is still not obeyed', () => {
        const $toast = toastr.info('message', '', { positionClass: 'toast-bottom-left', containerId: 'other-container' });
        expect($toast.closest('#toast-container').length).toBe(1);
        expect(document.getElementById('other-container')).toBeNull();
        expect(document.getElementById('toast-container').className).toBe('toast-top-center');
    });

    test('resetToastQueue switches the queue on again', () => {
        toastQueue.resetToastQueue();
        const $toast = toastr.info('message');
        expect($toast.closest('#toast-container').length).toBe(1);
        expect(toastQueue.getToastQueue().current).toBeNull();
    });
});
