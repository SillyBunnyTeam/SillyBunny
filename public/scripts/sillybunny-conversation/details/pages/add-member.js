import { mountPicker } from '../../../sillybunny-editor/picker.js';
import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { getCharacterPickerOptions, requireView } from '../access.js';
import { addMembersTo } from '../actions.js';
import { getPageTitle } from '../details-logic.js';
import { createGroup, createPage } from '../page-kit.js';

/**
 * Pick-several list of the characters that are not in the conversation, the list of the New Group picker: sorted with
 * favourites first, in batches of 50, with the tag filter. Add puts them in a group; from a direct conversation it starts a
 * new group of that character and the chosen ones, which then opens.
 */
export function buildAddMember({ conversationId, nav }) {
    const view = requireView(conversationId);
    const options = getCharacterPickerOptions({ exclude: new Set([...view.characters, ...view.extras]) });
    const chosen = new Set();
    let setAddEnabled = () => {};

    const host = document.createElement('div');
    host.className = 'sb-details-picker-list sb-picker sb-picker--inline';
    const mounted = mountPicker(host, {
        ...options,
        title: 'Characters',
        multiple: true,
        searchLabel: 'Search Characters',
        searchPlaceholder: 'Search',
        emptyText: 'No Results Found',
        getItemState: avatar => (chosen.has(avatar) ? 'selected' : null),
        onSelect: avatar => {
            if (chosen.has(avatar)) {
                chosen.delete(avatar);
            } else {
                chosen.add(avatar);
            }
            setAddEnabled('add', chosen.size > 0);
        },
    });

    const none = createStatusPage({ state: 'empty', icon: 'user-plus', title: 'No Characters to Add', compact: true });
    none.element.hidden = options.items.length > 0;
    host.hidden = options.items.length === 0;

    const { page, clamp } = createPage('sb-details-page--picker');
    const group = createGroup({ label: 'Characters', rows: [], field: 'add-member' });
    group.group.append(host);
    clamp.append(group.section, none.element);
    return {
        title: getPageTitle('add-member'),
        content: page,
        responses: { cancel: {}, affirmative: { id: 'add', label: 'Add', enabled: false } },
        onMount({ setResponseEnabled }) {
            setAddEnabled = setResponseEnabled;
            queueMicrotask(() => mounted.focusSearch());
        },
        dispose: () => mounted.destroy(),
        async onResponse() {
            const { switched } = await addMembersTo(requireView(conversationId), [...chosen]);
            if (switched) {
                nav.close();
            }
        },
    };
}
