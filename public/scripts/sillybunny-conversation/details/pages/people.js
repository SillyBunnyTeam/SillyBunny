import { describeCharacterStatus, getCardName } from '../access.js';
import { createCharacterAvatar } from '../avatars.js';
import { removeExtraMember, removeGroupMember } from '../member-actions.js';
import { createCollectionRow, createRemoveButton } from '../page-kit.js';

/**
 * A row for a person of a conversation: a press opens the profile, and the Remove button ends the row.
 * @param {{ conversationId: string, avatar: string, kind: 'member'|'extra', nav: any }} options
 * @returns {HTMLElement}
 */
export function createPersonRow({ conversationId, avatar, kind, nav }) {
    const name = getCardName(avatar);
    const remove = kind === 'member'
        ? () => removeGroupMember({ conversationId, avatar, nav })
        : () => removeExtraMember({ conversationId, avatar });
    const { row } = createCollectionRow({
        key: `person:${avatar}`,
        label: name,
        avatar: createCharacterAvatar(avatar, { size: 36 }),
        subtitle: describeCharacterStatus(avatar).line,
        onActivate: () => nav.push('profile', { avatar }),
        end: [createRemoveButton(`Remove ${name}`, remove)],
    });
    return row;
}
