import { t } from '../i18n.js';
import { openAlert } from '../sillybunny-editor/dialog.js';
import { COPY_PLACEHOLDER, markCopyPlaceholder } from './copy.js';

const HEADING_SLOT = 'AS-UPDATE-HEAD';
const BODY_SLOT = 'AS-UPDATE-BODY';

/**
 * Asks whether a card that the user edited should become the newer bundled one. Escape and the scrim answer
 * `cancel`, which changes nothing and is not a choice to keep the card: the question comes back the next time.
 * @returns {Promise<'update' | 'keep' | 'cancel'>}
 */
export function openManagedUpdateAlert() {
    const body = markCopyPlaceholder(document.createElement('p'), BODY_SLOT);
    const answer = openAlert({
        heading: COPY_PLACEHOLDER,
        bodyNode: body,
        // Keep Mine comes first and takes the focus, so a stray Return cannot replace the user's card.
        responses: [
            { id: 'keep', label: t`Keep Mine` },
            { id: 'update', label: t`Update`, appearance: 'suggested' },
        ],
        defaultResponse: null,
        closeResponse: 'cancel',
    });
    // The heading is made by the alert, which has no copy slots, so the marks go on once it is in the page.
    const heading = body.closest('dialog')?.querySelector('.sb-dialog__heading');
    if (heading instanceof HTMLElement) {
        markCopyPlaceholder(heading, HEADING_SLOT);
    }
    return /** @type {Promise<'update' | 'keep' | 'cancel'>} */ (answer);
}
