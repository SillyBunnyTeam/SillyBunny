/** A fixed tag list, with the first few tags assigned to the audit character. Settings only. See `index.js` for the shape of a need module. */

import { fixture as character } from './character.js';

const CREATED = Date.UTC(2026, 0, 1, 12, 0, 0);

export const fixture = Object.freeze({
    names: Object.freeze(['Audit Alpha', 'Audit Beta', 'Audit Gamma', 'Audit Delta', 'Audit Epsilon', 'Audit Zeta', 'Audit Eta', 'Audit Theta']),
    assigned: 3,
});

const tagId = index => `audit-tag-${index + 1}`;

export default {
    requires: ['character'],
    settings(settings) {
        settings.tags = fixture.names.map((name, index) => ({
            id: tagId(index), name, color: '', color2: '', folder_type: 'NONE', sort_order: index, create_date: CREATED,
        }));
        settings.tag_map = { [character.avatar]: fixture.names.slice(0, fixture.assigned).map((_name, index) => tagId(index)) };
    },
};
