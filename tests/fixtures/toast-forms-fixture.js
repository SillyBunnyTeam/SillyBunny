/**
 * Test-only. An e2e spec injects this file into the app page. It fires, through the real `toastr`, the patterns that
 * extensions use (`research-extensions.md`), and keeps what the callbacks did in `window.__toastFormsCalls`.
 * Every function returns data that Playwright can serialize.
 */
(() => {
    const calls = [];
    window.__toastFormsCalls = calls;

    const MARKER = { toast: 'sb-form-toast', notification: 'sb-form-notification' };

    /** Where a toast element is and which form it carries. */
    function describe(toast) {
        const element = toast?.[0];
        if (!element) {
            return null;
        }
        const container = element.parentElement;
        return {
            form: element.classList.contains(MARKER.toast) ? 'toast' : element.classList.contains(MARKER.notification) ? 'notification' : 'none',
            containerId: container?.id ?? null,
            containerClass: container?.className ?? null,
            html: element.querySelector('.toast-message')?.innerHTML ?? null,
            title: element.querySelector('.toast-title')?.textContent ?? null,
            classes: element.className,
        };
    }

    /** The text width of a line in the font of a toast, in px, laid out on one line. */
    function lineWidth(text, referenceToast) {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;left:-10000px;top:0;';
        const style = getComputedStyle(referenceToast);
        // The `font` shorthand is not serialized by every engine, so each property is copied.
        for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing']) {
            probe.style[property] = style[property];
        }
        probe.textContent = text;
        document.body.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
    }

    window.__toastForms = {
        calls,
        describe,

        /** A plain message, with or without a title. */
        plain(kind, message, title, options) {
            return describe(window.toastr[kind](message, title, options));
        },

        /** WebLLM: a titled progress toast that is hidden, shown, edited in place and hidden again. */
        progressTitled() {
            const toast = window.toastr.info('Please wait...', 'WebLLM', { timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: false, progressBar: false }).hide();
            window.__progress = toast;
            toast.show();
            toast.find('.toast-message').text('Loading 40%');
            return describe(toast);
        },

        /** A progress toast with no title, whose text then grows far past one line. */
        progressUntitled() {
            const toast = window.toastr.info('Working', '', { timeOut: 0, extendedTimeOut: 0 });
            window.__progress = toast;
            return describe(toast);
        },

        growProgress(text) {
            window.__progress.find('.toast-message').text(text);
            return describe(window.__progress);
        },

        hideProgress() {
            window.__progress.hide();
        },

        showProgress() {
            window.__progress.show();
        },

        /** HTML with one button, as the Prompt Editor's Undo toast. */
        oneButton() {
            const toast = window.toastr.info('<span>Removed Main Prompt</span> <button type="button" class="menu_button" id="fx-undo">Undo</button>', '', { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
            toast.find('#fx-undo').on('click', () => calls.push('undo'));
            return describe(toast);
        },

        /** HTML with several buttons and several blocks, as the draft recovery message. */
        severalButtons() {
            const toast = window.toastr.info('<div>Unsaved changes</div><div><button type="button" id="fx-restore">Restore</button><button type="button" id="fx-discard">Discard</button></div>', '', { escapeHtml: false, tapToDismiss: false, timeOut: 0, extendedTimeOut: 0 });
            toast.find('#fx-restore').on('click', () => calls.push('restore'));
            toast.find('#fx-discard').on('click', () => calls.push('discard'));
            return describe(toast);
        },

        /** MemoryBooks: a link in a second line, with a handler on the returned element. */
        linkLine() {
            const toast = window.toastr.error('Summary failed<br><a href="#" class="fx-raw-link">Show the response</a>', 'STMemoryBooks', { timeOut: 0, extendedTimeOut: 0, closeButton: true, tapToDismiss: false, escapeHtml: false });
            toast.find('.fx-raw-link').on('click', (event) => {
                event.preventDefault();
                calls.push('link');
            });
            return describe(toast);
        },

        onclick() {
            const toast = window.toastr.info('Click me to open the details', '', { timeOut: 0, extendedTimeOut: 0, onclick: () => calls.push('onclick') });
            return describe(toast);
        },

        /** The second call returns nothing, and the first toast is still the only one. */
        preventDuplicates() {
            const first = window.toastr.info('Same text', '', { preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 });
            const second = window.toastr.info('Same text', '', { preventDuplicates: true, timeOut: 0, extendedTimeOut: 0 });
            return { first: describe(first), secondIsUndefined: second === undefined };
        },

        tapToDismissOff(title) {
            const toast = window.toastr.info('Stays when tapped', title, { tapToDismiss: false, timeOut: 0, extendedTimeOut: 0 });
            return describe(toast);
        },

        /** An extension that writes the global options, and the call that follows. */
        withGlobalWrites(write, call) {
            const saved = { ...window.toastr.options };
            Object.assign(window.toastr.options, write);
            try {
                return { toast: describe(window.toastr.info(call.toast, '', { timeOut: 0, extendedTimeOut: 0 })), notification: describe(window.toastr.info(call.notification, 'Title', { timeOut: 0, extendedTimeOut: 0 })) };
            } finally {
                window.toastr.options = saved;
            }
        },

        /** The positions, ids and targets that a call sets itself. */
        withCallOptions(options) {
            return { toast: describe(window.toastr.info('A toast', '', { ...options, timeOut: 0, extendedTimeOut: 0 })), notification: describe(window.toastr.info('A notification', 'Title', { ...options, timeOut: 0, extendedTimeOut: 0 })) };
        },

        /** WI-Bulk-Mover: every toast is hidden by a class, and its own toasts name `toast` as their class. */
        hideByClass(on) {
            window.toastr.options.toastClass = on ? 'displayNone' : 'toast';
            if (on) {
                window.toastr.options.preventDuplicates = false;
            }
        },

        /** ToastHistory: reads the message of the element straight after the call and keeps a clone. */
        readerRightAfterTheCall(message, title) {
            const toast = window.toastr.info(message, title, { timeOut: 0, extendedTimeOut: 0, escapeHtml: false });
            const read = toast[0].querySelector('.toast-message').innerHTML;
            const clone = toast[0].cloneNode(true);
            window.__history = [clone];
            return { read, cloneIsToast: clone.classList.contains('toast'), form: describe(toast).form };
        },

        /** SmartNotify: an outer wrapper that returns null for a toast that it blocks. */
        installNullWrapper() {
            const inner = window.toastr.info;
            window.__innerInfo = inner;
            window.toastr.info = (...args) => {
                inner(...args);
                return null;
            };
        },

        removeNullWrapper() {
            window.toastr.info = window.__innerInfo;
        },

        /** `/echo` with a class: toastr's `toastClass` keeps `toast` and adds the class. */
        echoWithClass() {
            return describe(window.toastr.info('From echo', '', { toastClass: 'toast fx-echo-class', timeOut: 0, extendedTimeOut: 0 }));
        },

        /** A SillyBunny dialog host (`openDialog`), which opens with showModal() and is removed with close() and remove(). */
        async openFrame() {
            const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
            window.__frame = openDialog({ tier: 'dialog', title: 'Fixture', content: document.createElement('div'), responses: { cancel: {}, affirmative: { id: 'ok', label: 'Save' } } });
        },

        async closeFrame() {
            await window.__frame.close('cancel');
            await window.__frame.closed;
        },

        /** An alert, which closes through its own response button. */
        async openAlertFrame() {
            const { openAlert } = await import('/scripts/sillybunny-editor/dialog.js');
            void openAlert({ heading: 'Fixture alert', body: 'A body', responses: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK' }] });
        },

        /** A modal dialog of an extension: plain showModal(), and close() with remove() in one task. */
        openRawModal() {
            const dialog = document.createElement('dialog');
            dialog.id = 'fx-raw-modal';
            dialog.textContent = 'An extension dialog';
            // A dialog of an extension holds its content, so it is larger than one line of text.
            dialog.style.cssText = 'width: 360px; height: 220px;';
            document.body.append(dialog);
            dialog.showModal();
        },

        closeRawModal() {
            const dialog = document.getElementById('fx-raw-modal');
            dialog.close();
            dialog.remove();
        },

        clearAll() {
            window.toastr.clear();
        },

        removeAll() {
            window.toastr.remove();
        },

        /**
         * A message whose one-line width in a toast is `delta` px under (negative) or over the limit of 34em. The toast counts
         * as a whole against 34em, so the parts around the label (padding, glyph and close button) are taken off the text,
         * and the text is measured in the font of the label.
         */
        messageNearLimit(delta) {
            const reference = window.toastr.info('reference', '', { timeOut: 0, extendedTimeOut: 0 });
            const element = reference[0];
            const label = element.querySelector('.toast-message');
            const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
            const chrome = element.getBoundingClientRect().width - lineWidth('reference', label);
            const target = 34 * fontSize - chrome + delta;
            let text = 'n';
            while (lineWidth(text, label) < target) {
                text += text.length % 7 === 6 ? ' n' : 'n';
            }
            const width = lineWidth(text, label);
            element.remove();
            return { text, fontSize, padding: chrome, width };
        },
    };
})();
