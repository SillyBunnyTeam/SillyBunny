/**
 * Removing a person from a conversation, for the General and Members pages. A member of a group goes at once, with Undo;
 * the second-to-last member is confirmed first, because the group then becomes the direct conversation of the member
 * that is left. An extra cannot be added back, so removing one is confirmed.
 */

import { openAlert } from '../../sillybunny-editor/dialog.js';
import { openConversation } from './actions.js';
import { conversationData, getCardName, getView } from './access.js';
import { planMemberRemoval } from './details-logic.js';
import { copyPlaceholder, el, showUndoToast } from './page-kit.js';

async function confirmRemoval(name) {
    const body = el('div', 'sb-details-alert-body');
    body.append(copyPlaceholder());
    return await openAlert({
        heading: `Remove ${name}?`,
        bodyNode: body,
        responses: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'remove', label: 'Remove', appearance: 'destructive' },
        ],
        closeResponse: 'cancel',
    }) === 'remove';
}

function reportFailure(message, error) {
    console.error(`Conversation Mode: ${message}`, error);
    globalThis.toastr?.error?.(message);
}

/**
 * The Remove button of a member row of a group.
 * @param {{ conversationId: string, avatar: string, nav: { reroot: Function, toast: Function } }} options
 */
export async function removeGroupMember({ conversationId, avatar, nav }) {
    const view = getView(conversationId);
    const plan = planMemberRemoval(view, avatar);
    if (plan.action === 'none') {
        return;
    }
    const name = getCardName(avatar);
    if (plan.action === 'convert') {
        const remainingName = getCardName(plan.remaining);
        if (!await confirmRemoval(name)) {
            return;
        }
        let result;
        try {
            result = await conversationData.removeMember(conversationId, avatar);
        } catch (error) {
            reportFailure(`${name} could not be removed`, error);
            return;
        }
        nav.toast(`${name} removed. This is now a conversation with ${remainingName}`);
        nav.reroot(result.conversation.id);
        await openConversation(result.conversation);
        return;
    }
    try {
        await conversationData.removeMember(conversationId, avatar);
    } catch (error) {
        reportFailure(`${name} could not be removed`, error);
        return;
    }
    showUndoToast(`Removed ${name}`, async () => {
        try {
            await conversationData.addMembers(conversationId, [avatar]);
        } catch (error) {
            reportFailure(`${name} could not be added back`, error);
        }
    });
}

/** The Remove button of an extra of a direct conversation. */
export async function removeExtraMember({ conversationId, avatar }) {
    const name = getCardName(avatar);
    if (!await confirmRemoval(name)) {
        return;
    }
    try {
        await conversationData.removeExtra(conversationId, avatar);
    } catch (error) {
        reportFailure(`${name} could not be removed`, error);
    }
}
