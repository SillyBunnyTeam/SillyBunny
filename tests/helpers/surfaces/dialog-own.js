/**
 * Popups that keep their own frame: the hook leaves a crop and a transparent image zoom alone (`resolvePopupTier`), so they
 * are not Alert, Dialog or Window. They are the Popup classes CROP and DISPLAY, each reached through a representative call.
 */

import { closeDialogs, closeFrame, OWN_POPUP, settleFrame } from './dialog-steps.js';

const SCRIPTS = 'public/scripts';

/** An image that the app serves itself, so that a run needs no network. */
const IMAGE = '/img/ai4.png';

/**
 * @param {object} entry
 * @param {string} entry.id The last segments of the id, after `dialog.own-frame.`.
 * @returns {import('./index.js').Surface}
 */
function own({ id, ...rest }) {
    return {
        id: `dialog.own-frame.${id}`,
        family: 'dialog',
        owner: 'B',
        root: OWN_POPUP,
        close: closeFrame(OWN_POPUP),
        needs: [],
        ...rest,
    };
}

/** @type {import('./index.js').Surface[]} */
export const surfaces = [
    own({
        id: 'crop',
        title: 'Popup crop (the cropper over an image, with Crop and Cancel; the avatar upload of an account)',
        ready: [`${OWN_POPUP} .cropper-container`, `${OWN_POPUP} .popup-button-ok`],
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(async (image) => {
                const { callGenericPopup, POPUP_TYPE } = await import('/scripts/popup.js');
                void callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropAspect: 1, cropImage: image });
            }, IMAGE);
            await settleFrame(page, OWN_POPUP);
            await page.locator(`${OWN_POPUP} .cropper-container`).first().waitFor({ state: 'visible' });
        },
        sources: [`${SCRIPTS}/popup.js`, `${SCRIPTS}/user.js`, 'public/css/popup.css'],
    }),
    own({
        id: 'image-zoom',
        title: 'Popup display, transparent (an enlarged message image, closed by a click)',
        ready: `${OWN_POPUP} .img_enlarged`,
        async open(page) {
            await closeDialogs(page);
            await page.evaluate(async (image) => {
                const { Popup, POPUP_TYPE } = await import('/scripts/popup.js');
                const picture = document.createElement('img');
                picture.src = image;
                picture.classList.add('img_enlarged');
                const holder = document.createElement('div');
                holder.classList.add('img_enlarged_holder');
                holder.append(picture);
                const container = document.createElement('div');
                container.classList.add('img_enlarged_container');
                container.append(holder);
                const popup = new Popup(container, POPUP_TYPE.DISPLAY, '', { large: true, transparent: true });
                popup.dlg.style.width = 'unset';
                popup.dlg.style.height = 'unset';
                popup.dlg.addEventListener('click', () => popup.completeCancelled());
                void popup.show();
            }, IMAGE);
            await settleFrame(page, OWN_POPUP);
            await page.waitForFunction(() => document.querySelector('dialog.popup[open] .img_enlarged')?.complete);
        },
        sources: [`${SCRIPTS}/chats.js`, `${SCRIPTS}/popup.js`, 'public/css/popup.css'],
    }),
];
