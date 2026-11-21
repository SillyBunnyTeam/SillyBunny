/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for a DOM helper. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));

/** What the alert builds around its arguments, as far as the module under test relies on it. */
const openAlert = jest.fn((options) => {
    const host = document.createElement('dialog');
    host.innerHTML = '<section><div class="sb-dialog__body"><h2 class="sb-dialog__heading"></h2><div class="sb-dialog__message"></div></div></section>';
    host.querySelector('.sb-dialog__heading').textContent = options.heading;
    host.querySelector('.sb-dialog__message').append(options.bodyNode);
    document.body.append(host);
    return Promise.resolve('keep');
});
jest.unstable_mockModule('../../public/scripts/sillybunny-editor/dialog.js', () => ({ openAlert }));
const { openManagedUpdateAlert } = await import('../../public/scripts/sillybunny-home/managed-update-alert.js');

afterEach(() => {
    document.body.replaceChildren();
    openAlert.mockClear();
});

describe('the question of an update', () => {
    test('answers with the response that the alert resolved with', async () => {
        openAlert.mockResolvedValueOnce('update');

        await expect(openManagedUpdateAlert('Reisen')).resolves.toBe('update');
    });

    test('has Keep Mine first and Update last, which is the suggested response', async () => {
        await openManagedUpdateAlert('Reisen');

        const { responses } = openAlert.mock.calls[0][0];
        expect(responses.map(({ id, label }) => [id, label])).toEqual([['keep', 'Keep Mine'], ['update', 'Update']]);
        expect(responses.map(response => response.appearance)).toEqual([undefined, 'suggested']);
    });

    test('has no response that Return activates, so a stray key neither updates nor keeps', async () => {
        await openManagedUpdateAlert('Reisen');

        expect(openAlert.mock.calls[0][0].defaultResponse).toBeNull();
    });

    test('answers Escape and the scrim with a response that is neither of the two', async () => {
        await openManagedUpdateAlert('Reisen');

        const { closeResponse, responses } = openAlert.mock.calls[0][0];
        expect(responses.map(response => response.id)).not.toContain(closeResponse);
        expect(closeResponse).toBe('cancel');
    });

    test('names the card in the heading', async () => {
        await openManagedUpdateAlert('Tewi');

        expect(openAlert.mock.calls[0][0].heading).toBe('Update Tewi?');
        expect(document.querySelector('.sb-dialog__heading').textContent).toBe('Update Tewi?');
    });

    test('says in the body that the user edited the card, and that the copy is kept as a backup', async () => {
        await openManagedUpdateAlert('Tewi');

        const body = document.querySelector('.sb-dialog__message [data-sb-managed-update="body"]');
        expect(body.textContent).toBe('A newer version of Tewi is available, but you\'ve edited your copy. Would you like to update anyway? Your copy is saved as a backup.');
        expect(document.querySelector('dialog [data-sb-copy-placeholder]')).toBeNull();
    });

    test('has no visible text of its own apart from the heading, the body and the two labels', async () => {
        await openManagedUpdateAlert('Tewi');

        expect(document.querySelector('dialog').textContent).toBe('Update Tewi?A newer version of Tewi is available, but you\'ve edited your copy. Would you like to update anyway? Your copy is saved as a backup.');
    });
});
