/**
 * Two scenario notes (appendices) on the audit persona, one of them switched on, so that the Scenario Notes section of the
 * persona editor has rows. They live in the persona's descriptor in the account settings, so the settings answer carries
 * them. See `index.js` for the shape of a need module.
 */

import { fixture as persona } from './persona.js';
import { sentences } from '../need-kit.js';

export const fixture = Object.freeze({
    avatar: persona.avatar,
    notes: Object.freeze([
        Object.freeze({ id: 'audit-note-active', name: 'Audit Active Note', description: `Applies to every chat. ${sentences(3, 1)}` }),
        Object.freeze({ id: 'audit-note-idle', name: 'Audit Idle Note', description: `Switched off. ${sentences(3, 2)}` }),
    ]),
});

/** The scope that the app uses when no character or group is selected. */
const DEFAULT_SCOPE = '__default__';

export default {
    requires: ['persona'],
    settings(settings) {
        const descriptors = settings.power_user.persona_descriptions;
        descriptors[persona.avatar] = {
            ...descriptors[persona.avatar],
            appendices: fixture.notes.map(note => ({ ...note })),
            activeAppendices: { [DEFAULT_SCOPE]: [fixture.notes[0].id] },
        };
    },
};
