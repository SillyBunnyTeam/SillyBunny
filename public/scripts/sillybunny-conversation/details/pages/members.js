import { requireView } from '../access.js';
import { getGeneralSignature, getMembersPage } from '../details-logic.js';
import { copyPlaceholder, createCollection, createHint, createPage, createPillButton, redrawKeepingFocus, watchConversation } from '../page-kit.js';
import { createPersonRow } from './people.js';

/**
 * The people of a conversation for removal: the members of a group bigger than four, and the extras of a direct
 * conversation. A group of up to four lists its members on General.
 */
export function buildMembers({ conversationId, nav }) {
    const first = requireView(conversationId);
    const info = getMembersPage(first);
    if (!info) {
        throw new Error('This conversation has no members to list.');
    }
    const { page, clamp } = createPage('sb-details-page--members');
    const list = createCollection(info.title);

    const draw = () => {
        const view = requireView(conversationId);
        const current = getMembersPage(view);
        if (!current) {
            nav.pop();
            return;
        }
        redrawKeepingFocus(list, () => {
            list.replaceChildren(...current.avatars.map(avatar => createPersonRow({ conversationId, avatar, kind: current.kind, nav })));
            if (!current.avatars.length) {
                list.append(createHint('No members'));
            }
        });
    };
    draw();
    clamp.append(list);

    if (info.kind === 'member') {
        const action = document.createElement('div');
        action.className = 'sb-details-page-action';
        action.append(createPillButton('Add Member', { onClick: () => nav.push('add-member') }));
        clamp.append(action);
    } else {
        // An extra no longer speaks, and none can be added; why is for the maintainer to say.
        clamp.append(copyPlaceholder('p', 'sb-details-note'));
    }

    const stop = watchConversation(conversationId, getGeneralSignature, { onChange: draw, onGone: () => nav.gone() });
    return { title: info.title, content: page, dispose: stop };
}
