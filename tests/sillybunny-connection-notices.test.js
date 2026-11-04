/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, jest, test } from '@jest/globals';

await jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => `${text}${part}${values[index] ?? ''}`, ''),
}));

const fixToastrForDialogs = jest.fn();
await jest.unstable_mockModule('../public/scripts/popup.js', () => ({ fixToastrForDialogs }));

const { CONNECTION_NOTICE_KINDS, flagMissingKey, notifyNotConnected } = await import('../public/scripts/sillybunny-connection-notices.js');

function createToast() {
    return {
        warning: jest.fn(() => {
            const element = document.createElement('div');
            document.body.append(element);
            return [element];
        }),
        clear: jest.fn(),
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    fixToastrForDialogs.mockClear();
});

describe('notifyNotConnected', () => {
    test('says the API is not connected, says what to do, and offers a Show Me button', () => {
        const toast = createToast();
        notifyNotConnected({ toast, openTarget: jest.fn() });

        const [message, title, options] = toast.warning.mock.calls[0];
        expect(title).toBe('Not connected to API!');
        expect(options.escapeHtml).toBe(false);
        const body = message.querySelector('[data-sb-connection-notice]');
        expect(body.dataset.sbConnectionNotice).toBe(CONNECTION_NOTICE_KINDS.notConnected);
        expect(body.textContent).toBe('Your message wasn\'t sent. Connect a model first, then send it again.');
        expect(body.hasAttribute('data-sb-copy-placeholder')).toBe(false);
        expect(message.querySelector('button').textContent).toBe('Show Me');
    });

    test('Show Me closes the notice and opens Connections', () => {
        const toast = createToast();
        const openTarget = jest.fn();
        notifyNotConnected({ toast, openTarget });

        toast.warning.mock.calls[0][0].querySelector('button').click();

        expect(openTarget).toHaveBeenCalledWith('connections');
        expect(toast.clear).toHaveBeenCalledWith(toast.warning.mock.results[0].value, { force: true });
    });

    test('keeps the toast container alive for open dialogs when it hides, and allows a new notice', () => {
        const toast = createToast();
        notifyNotConnected({ toast, openTarget: jest.fn() });

        toast.warning.mock.calls[0][2].onHidden();
        notifyNotConnected({ toast, openTarget: jest.fn() });

        expect(fixToastrForDialogs).toHaveBeenCalledTimes(1);
        expect(toast.warning).toHaveBeenCalledTimes(2);
    });

    test('does not stack a second notice while the first is on screen', () => {
        const toast = createToast();
        notifyNotConnected({ toast, openTarget: jest.fn() });
        notifyNotConnected({ toast, openTarget: jest.fn() });

        expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    test('shows the notice again once the first is gone', () => {
        const toast = createToast();
        notifyNotConnected({ toast, openTarget: jest.fn() });
        document.body.innerHTML = '';
        notifyNotConnected({ toast, openTarget: jest.fn() });

        expect(toast.warning).toHaveBeenCalledTimes(2);
    });
});

describe('flagMissingKey', () => {
    beforeEach(() => {
        document.body.innerHTML = '<input id="key" type="text">';
    });

    test('does not stack a second Missing key notice', () => {
        const toast = createToast();
        const input = document.getElementById('key');
        flagMissingKey(input, { toast });
        flagMissingKey(input, { toast });
        expect(toast.warning).toHaveBeenCalledTimes(1);
        expect(input.getAttribute('aria-invalid')).toBe('true');
    });

    test('marks the key field invalid, focuses it and says what is missing', () => {
        const toast = createToast();
        const input = document.getElementById('key');

        flagMissingKey(input, { toast });

        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(document.activeElement).toBe(input);
        const [message, title] = toast.warning.mock.calls[0];
        expect(title).toBe('Missing key');
        expect(message.dataset.sbConnectionNotice).toBe(CONNECTION_NOTICE_KINDS.missingKey);
        expect(message.textContent).toBe('Enter your API key, then press Connect.');
        expect(message.hasAttribute('data-sb-copy-placeholder')).toBe(false);
    });

    test('clears the mark as soon as the user types', () => {
        const input = document.getElementById('key');
        flagMissingKey(input, { toast: createToast() });

        input.dispatchEvent(new Event('input', { bubbles: true }));

        expect(input.hasAttribute('aria-invalid')).toBe(false);
    });

    test('still tells the user when the field cannot be found', () => {
        const toast = createToast();
        flagMissingKey(null, { toast });
        expect(toast.warning).toHaveBeenCalledTimes(1);
    });
});
