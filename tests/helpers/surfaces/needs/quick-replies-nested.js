/**
 * Three Quick Reply sets that make a context menu with a submenu: the set that is enabled globally has one reply whose
 * context menu links to a second set, and a reply of that set links to a third. The sets are saved through
 * `/api/quick-replies/save` as the extension saves them, and the switch that enables the first lives in the extension's
 * settings, so it comes with the settings answer. See `index.js` for the shape of a need module.
 */

import { enableExtensions, extensionSettings, readSettingsAnswer } from '../need-kit.js';

/** `main` is enabled globally; its reply links to `branch`, whose reply `branch.replies[0]` links to `leaves`. */
export const fixture = Object.freeze({
    main: Object.freeze({ name: 'Audit Nested Menu', replies: Object.freeze(['Nested menu']) }),
    branch: Object.freeze({ name: 'Audit Nested Branch', replies: Object.freeze(['Branch', 'Plain']) }),
    leaves: Object.freeze({ name: 'Audit Nested Leaves', replies: Object.freeze(['Leaf one', 'Leaf two']) }),
});

function reply(id, label, message, contextList = []) {
    return {
        id, icon: '', showLabel: false, label, title: '', message, contextList, preventAutoExecute: true, isHidden: false,
        executeOnStartup: false, executeOnUser: false, executeOnAi: false, executeOnChatChange: false,
        executeOnGroupMemberDraft: false, executeOnNewChat: false, executeBeforeGeneration: false, automationId: '',
    };
}

function buildSets() {
    const { main, branch, leaves } = fixture;
    const set = (name, qrList) => ({
        version: 2, name, disableSend: false, placeBeforeInput: false, injectInput: false, color: 'transparent', onlyBorderColor: false,
        qrList, idIndex: qrList.length,
    });
    return [
        set(main.name, [reply(1, main.replies[0], 'Open the menu.', [{ set: branch.name, isChained: false }])]),
        set(branch.name, [
            reply(1, branch.replies[0], 'Take the branch.', [{ set: leaves.name, isChained: false }]),
            reply(2, branch.replies[1], 'Stay plain.'),
        ]),
        set(leaves.name, leaves.replies.map((label, index) => reply(index + 1, label, `*${label.toLowerCase()}*`))),
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
        return `quick reply sets ${fixture.main.name}, ${fixture.branch.name}, ${fixture.leaves.name}`;
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
