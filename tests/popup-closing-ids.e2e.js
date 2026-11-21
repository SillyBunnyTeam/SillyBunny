import { expect, test } from '@playwright/test';
import { protectMaintainerServer } from './helpers/maintainer-server.js';
import { waitForAppReady } from './helpers/app-ready.js';

// A closing Popup stays in the document until its exit animation ends. A Popup that holds the same ids and opens in
// that time must wait for it, or the document holds every id of the form twice.

test.use({ viewport: { width: 1440, height: 900 } });

test('a Popup whose content repeats the ids of a closing Popup opens after the closing one is gone', async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });

    const report = await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const build = label => {
            const content = document.createElement('div');
            content.innerHTML = `<h3>${label}</h3><input id="qa-fixed-id-field" value="${label}"><label for="qa-fixed-id-field">Field</label>`;
            return content;
        };
        const copiesOfId = () => document.querySelectorAll('#qa-fixed-id-field').length;

        let mostCopies = 0;
        const watch = new MutationObserver(() => { mostCopies = Math.max(mostCopies, copiesOfId()); });
        watch.observe(document.body, { childList: true, subtree: true });

        const first = new Popup(build('first'), POPUP_TYPE.TEXT, '', { okButton: 'OK', cancelButton: null });
        void first.show();
        const firstGone = first.completeAffirmative();
        const firstWasClosing = first.dlg.hasAttribute('closing');

        const second = new Popup(build('second'), POPUP_TYPE.TEXT, '', { okButton: 'OK', cancelButton: null });
        const secondShown = second.show();
        const copiesRightAfterShow = copiesOfId();

        await firstGone;
        const secondField = await new Promise(resolve => {
            const poll = () => {
                const field = second.dlg.querySelector('#qa-fixed-id-field');
                if (second.dlg.hasAttribute('open') && field?.isConnected) resolve(field.value);
                else requestAnimationFrame(poll);
            };
            poll();
        });
        const copiesWhenSecondIsOpen = copiesOfId();
        const firstStillInDocument = first.dlg.isConnected;

        void second.completeAffirmative();
        await secondShown;
        watch.disconnect();
        return { firstWasClosing, copiesRightAfterShow, copiesWhenSecondIsOpen, firstStillInDocument, mostCopies, secondField, copiesAtEnd: copiesOfId() };
    });

    expect(report.firstWasClosing).toBe(true);
    expect(report.mostCopies).toBe(1);
    expect(report.copiesRightAfterShow).toBe(1);
    expect(report).toMatchObject({ copiesWhenSecondIsOpen: 1, firstStillInDocument: false, secondField: 'second', copiesAtEnd: 0 });
});

test('a closing Popup whose onClose waits for a Popup with its ids does not hold that Popup for ever', async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });

    const report = await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const build = label => {
            const content = document.createElement('div');
            content.innerHTML = `<h3>${label}</h3><input id="qa-fixed-id-field">`;
            return content;
        };
        const second = new Popup(build('second'), POPUP_TYPE.TEXT, '', {
            okButton: 'OK',
            cancelButton: null,
            onOpen: popup => void popup.completeAffirmative(),
        });
        const first = new Popup(build('first'), POPUP_TYPE.TEXT, '', {
            okButton: 'OK',
            cancelButton: null,
            onClose: async () => { await second.show(); },
        });
        void first.show();
        const started = performance.now();
        await first.completeAffirmative();
        return { finished: true, seconds: (performance.now() - started) / 1000 };
    });

    expect(report.finished).toBe(true);
    expect(report.seconds).toBeLessThan(5);
});

test('a Popup with other ids opens at once while another closes', async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });

    const report = await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const build = (label, id) => {
            const content = document.createElement('div');
            content.innerHTML = `<h3>${label}</h3><input id="${id}">`;
            return content;
        };
        const first = new Popup(build('first', 'qa-first-field'), POPUP_TYPE.TEXT, '', { okButton: 'OK', cancelButton: null });
        void first.show();
        const firstGone = first.completeAffirmative();
        const second = new Popup(build('second', 'qa-second-field'), POPUP_TYPE.TEXT, '', { okButton: 'OK', cancelButton: null });
        const secondShown = second.show();
        const secondInDocumentAtOnce = second.dlg.isConnected;
        const firstStillClosing = first.dlg.hasAttribute('closing');
        await firstGone;
        void second.completeAffirmative();
        await secondShown;
        return { secondInDocumentAtOnce, firstStillClosing };
    });

    expect(report).toEqual({ secondInDocumentAtOnce: true, firstStillClosing: true });
});

test('a closing dialog stays modal until it is removed, so the page behind it stays inert', async ({ page }) => {
    await protectMaintainerServer(page);
    await page.goto('/');
    await waitForAppReady(page, { timeout: 60000 });

    const report = await page.evaluate(async () => {
        const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
        const { openDialog } = await import('/scripts/sillybunny-editor/dialog.js');
        const frame = openDialog({ title: 'QA dialog', content: document.createTextNode('QA') });
        void frame.close('cancel');
        const host = document.querySelector('dialog.sb-dialog-host[closing]');
        const frameState = { closing: Boolean(host), modal: host?.matches(':modal') ?? false };
        await frame.closed;

        const popup = new Popup('QA', POPUP_TYPE.TEXT, '', { okButton: 'OK', cancelButton: null });
        void popup.show();
        const popupGone = popup.completeAffirmative();
        const popupState = { closing: popup.dlg.hasAttribute('closing'), modal: popup.dlg.matches(':modal') };
        await popupGone;
        return { frameState, popupState };
    });

    expect(report.frameState).toEqual({ closing: true, modal: true });
    expect(report.popupState).toEqual({ closing: true, modal: true });
});
