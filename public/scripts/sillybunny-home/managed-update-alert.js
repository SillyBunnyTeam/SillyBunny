import { t } from '../i18n.js';
import { openAlert } from '../sillybunny-editor/dialog.js';

/**
 * Asks whether a card that the user edited should become the newer bundled one. Escape and the scrim answer
 * `cancel`, which changes nothing and is not a choice to keep the card: the question comes back the next time.
 * @param {string} name The name of the card, which the heading and the body use.
 * @returns {Promise<'update' | 'keep' | 'cancel'>}
 */
export function openManagedUpdateAlert(name) {
    const body = document.createElement('p');
    body.dataset.sbManagedUpdate = 'body';
    body.textContent = t`A newer version of ${name} is available, but you've edited your copy. Would you like to update anyway? Your copy is saved as a backup.`;
    return /** @type {Promise<'update' | 'keep' | 'cancel'>} */ (openAlert({
        heading: t`Update ${name}?`,
        bodyNode: body,
        // Keep Mine comes first and takes the focus, so a stray Return cannot replace the user's card.
        responses: [
            { id: 'keep', label: t`Keep Mine` },
            { id: 'update', label: t`Update`, appearance: 'suggested' },
        ],
        defaultResponse: null,
        closeResponse: 'cancel',
    }));
}
