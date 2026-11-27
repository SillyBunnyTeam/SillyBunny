import { buildAddMember } from './add-member.js';
import { buildAdvanced } from './advanced.js';
import { buildBehaviour } from './behaviour.js';
import { buildChats } from './chats.js';
import { buildEdit } from './edit.js';
import { buildGeneral } from './general.js';
import { buildMembers } from './members.js';
import { buildGroundedRules, buildPreferences } from './preferences.js';
import { buildProfile } from './profile.js';
import { buildFiles, buildMedia, buildPinned } from './shared.js';

const BUILDERS = Object.freeze({
    general: buildGeneral,
    edit: buildEdit,
    members: buildMembers,
    'add-member': buildAddMember,
    profile: buildProfile,
    chats: buildChats,
    media: buildMedia,
    files: buildFiles,
    pinned: buildPinned,
    behaviour: buildBehaviour,
    advanced: buildAdvanced,
    preferences: buildPreferences,
    'grounded-rules': buildGroundedRules,
});

export function isKnownPage(pageId) {
    return Object.hasOwn(BUILDERS, pageId);
}

/**
 * @param {string} pageId
 * @param {{ conversationId: string, nav: any }} context
 * @param {Record<string, any>} [args] What the page needs besides the conversation, such as `avatar` for a profile.
 * @returns {{ title: string, subtitle?: string, content: HTMLElement, responses?: object, onResponse?: Function, onMount?: Function, dispose?: Function }}
 * @throws {Error} For a page that does not exist, or one that cannot be built for this conversation.
 */
export function buildPage(pageId, context, args = {}) {
    if (!isKnownPage(pageId)) {
        throw new RangeError(`There is no details page "${pageId}".`);
    }
    return BUILDERS[pageId](context, args);
}
