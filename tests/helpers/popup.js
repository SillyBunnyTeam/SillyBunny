/** Accept the visible response; OK-only framed TEXT popups forward header Close to OK. */
export async function acceptPopup(popup) {
    await popup.locator('.popup-button-ok:visible, .sb-dialog__close:visible').click();
}
