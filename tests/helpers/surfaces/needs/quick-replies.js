/**
 * Two Quick Reply sets, saved through `/api/quick-replies/save` as the extension saves them. The main set has three
 * replies, one of which opens a context menu that links to the second set, and is enabled globally; that switch lives in the
 * extension's settings, so it comes with the settings answer. See `index.js` for the shape of a need module.
 */

import { enableExtensions, extensionSettings, readSettingsAnswer } from '../need-kit.js';

/** `main` is the set that is enabled globally; `menuReplyId` is the id of its reply with a context menu. */
export const fixture = Object.freeze({
    main: Object.freeze({ name: 'Audit Replies', replies: Object.freeze(['Greet', 'Describe the room', 'Ask a question']) }),
    extras: Object.freeze({ name: 'Audit Extras', replies: Object.freeze(['Wave', 'Nod']) }),
    menuReplyId: 2,
});

function reply(id, label, message, contextList = []) {
    return {
        id, icon: '', showLabel: false, label, title: '', message, contextList, preventAutoExecute: true, isHidden: false,
        executeOnStartup: false, executeOnUser: false, executeOnAi: false, executeOnChatChange: false,
        executeOnGroupMemberDraft: false, executeOnNewChat: false, executeBeforeGeneration: false, automationId: '',
    };
}

function buildSets() {
    const { main, extras } = fixture;
    const set = (name, qrList) => ({
        version: 2, name, disableSend: false, placeBeforeInput: false, injectInput: false, color: 'transparent', onlyBorderColor: false,
        qrList, idIndex: qrList.length,
    });
    return [
        set(main.name, [
            reply(1, main.replies[0], 'Hello there.'),
            reply(2, main.replies[1], 'Describe the room.', [{ set: extras.name, isChained: false }]),
            reply(3, main.replies[2], 'Can I ask a question?'),
        ]),
        set(extras.name, extras.replies.map((label, index) => reply(index + 1, label, `*${label.toLowerCase()}s*`))),
    ];
}

export default {
    async exists(api) {
        const saved = (await readSettingsAnswer(api)).quickReplyPresets ?? [];
        return buildSets().every(set => saved.some(candidate => candidate.name === set.name));
    },
    async seed({ post }) {
        for (const set of buildSets()) {
            await post('/api/quick-replies/save', { data: set });
        }
        return `quick reply sets ${fixture.main.name}, ${fixture.extras.name}`;
    },
    settings(settings) {
        enableExtensions(settings, ['quick-reply']);
        const extensions = extensionSettings(settings);
        const current = extensions.quickReplyV2 ?? {};
        const setList = (current.config?.setList ?? []).filter(link => link.set !== fixture.main.name);
        extensions.quickReplyV2 = {
            isCombined: false,
            isPopout: false,
            ...current,
            isEnabled: true,
            config: { ...current.config, setList: [...setList, { set: fixture.main.name, isVisible: true }] },
        };
    },
};
