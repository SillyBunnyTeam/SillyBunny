import { createCheckRow } from '../../../sillybunny-editor/rows.js';
import { createSearchEntry } from '../../../sillybunny-editor/search-entry.js';
import { createStatusPage } from '../../../sillybunny-editor/status-page.js';
import { getCardName, listCards, requireView } from '../access.js';
import { addMembersTo } from '../actions.js';
import { createCharacterAvatar } from '../avatars.js';
import { getPageTitle } from '../details-logic.js';
import { createGroup, createPage } from '../page-kit.js';

function matchesQuery(name, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) {
        return true;
    }
    return name.toLowerCase().split(/\s+/).some(word => word.startsWith(needle)) || name.toLowerCase().startsWith(needle);
}

/**
 * Pick-several list of the characters that are not in the conversation. Add puts them in a group; from a direct
 * conversation it starts a new group of that character and the chosen ones, which then opens.
 */
export function buildAddMember({ conversationId, nav }) {
    const view = requireView(conversationId);
    const taken = new Set([...view.characters, ...view.extras]);
    const candidates = listCards().filter(card => !taken.has(card.avatar));
    const chosen = new Set();
    const rows = new Map();
    let setAddEnabled = () => {};

    const list = document.createElement('div');
    list.className = 'sb-details-picker-list';
    for (const card of candidates) {
        const picture = createCharacterAvatar(card.avatar, { size: 32 });
        picture.classList.add('sb-details-picker-avatar');
        const row = createCheckRow({
            label: getCardName(card.avatar),
            field: `candidate-${card.avatar}`,
            onChange: (checked) => {
                if (checked) {
                    chosen.add(card.avatar);
                } else {
                    chosen.delete(card.avatar);
                }
                setAddEnabled('add', chosen.size > 0);
            },
        });
        row.row.querySelector('input')?.after(picture);
        rows.set(card.avatar, row);
        list.append(row.row);
    }

    const empty = createStatusPage({ state: 'no-results', title: 'No Results Found', description: 'Try a different search', compact: true });
    empty.element.hidden = true;
    const none = createStatusPage({ state: 'empty', icon: 'user-plus', title: 'No Characters to Add', compact: true });
    none.element.hidden = candidates.length > 0;
    const search = createSearchEntry({
        label: 'Search Characters',
        placeholder: 'Search',
        variant: 'field',
        clearLabel: 'Clear',
        onInput: (query) => {
            let shown = 0;
            for (const [avatar, row] of rows) {
                const match = matchesQuery(getCardName(avatar), query);
                row.row.hidden = !match;
                shown += match ? 1 : 0;
            }
            empty.element.hidden = shown > 0 || !candidates.length;
        },
    });

    const { page, clamp } = createPage('sb-details-page--picker');
    const group = createGroup({ label: 'Characters', rows: [], field: 'add-member' });
    group.group.append(list);
    clamp.append(search.element, group.section, empty.element, none.element);
    return {
        title: getPageTitle('add-member'),
        content: page,
        responses: { cancel: {}, affirmative: { id: 'add', label: 'Add', enabled: false } },
        onMount({ setResponseEnabled }) {
            setAddEnabled = setResponseEnabled;
            queueMicrotask(() => search.focus());
        },
        async onResponse() {
            const { switched } = await addMembersTo(requireView(conversationId), [...chosen]);
            if (switched) {
                nav.close();
            }
        },
    };
}
