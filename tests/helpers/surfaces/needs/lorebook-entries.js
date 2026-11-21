/**
 * A second lorebook, separate from `lorebook` (which keeps its three plain entries), with six entries of different
 * kinds. See `index.js` for the shape of a need module.
 */

import { fixture as character } from './character.js';
import { sentences } from '../need-kit.js';

/** `kinds` maps each kind to the title of its entry; `book` is the lorebook name. */
export const fixture = Object.freeze({
    book: 'audit-lorebook-entries',
    kinds: Object.freeze({
        constant: 'Always On',
        keyed: 'Keyed With Secondary Keys',
        disabled: 'Disabled Entry',
        grouped: 'Grouped Entry',
        long: 'Long Content',
        filtered: 'Character Filter',
    }),
    secondaryKeys: Object.freeze(['harbour', 'bell']),
    groupName: 'audit-entry-group',
});

function entry(uid, kind, overrides) {
    const title = fixture.kinds[kind];
    return {
        uid, comment: title, key: [title.toLowerCase().split(' ')[0]], keysecondary: [], content: `${title}. ${sentences(2, uid)}`,
        constant: false, vectorized: false, selective: true, selectiveLogic: 0, order: 100 + uid, position: 0, disable: false,
        displayIndex: uid, probability: 100, useProbability: true, depth: 4, group: '', groupOverride: false, groupWeight: 100,
        ...overrides,
    };
}

function buildEntries() {
    return [
        entry(0, 'constant', { constant: true, key: [] }),
        entry(1, 'keyed', { key: ['lamp', 'desk'], keysecondary: [...fixture.secondaryKeys], selective: true, selectiveLogic: 0 }),
        entry(2, 'disabled', { disable: true }),
        entry(3, 'grouped', { group: fixture.groupName, groupWeight: 100 }),
        entry(4, 'long', { content: sentences(90, 4), order: 104 }),
        entry(5, 'filtered', { characterFilter: { isExclude: false, names: [character.name], tags: [] } }),
    ];
}

export default {
    async exists({ post }) {
        return (await post('/api/worldinfo/get', { data: { name: fixture.book } }, { allow: [404, 500] })).ok();
    },
    async seed({ post }) {
        const entries = Object.fromEntries(buildEntries().map(item => [item.uid, item]));
        await post('/api/worldinfo/edit', { data: { name: fixture.book, data: { entries } } });
        return `lorebook ${fixture.book}`;
    },
};
