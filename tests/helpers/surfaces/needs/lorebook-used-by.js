/**
 * The audit lorebook linked to the audit persona, so that the Used By list of the lorebook has a row. The link lives in the
 * account settings (`power_user.persona_descriptions`), so this need is settings only. See `index.js` for the shape of a
 * need module.
 */

import { fixture as lorebook } from './lorebook.js';
import { fixture as persona } from './persona.js';

export const fixture = Object.freeze({ lorebook: lorebook.name, persona: persona.name, avatar: persona.avatar });

export default {
    requires: ['lorebook', 'persona'],
    settings(settings) {
        const descriptions = settings.power_user.persona_descriptions ?? {};
        settings.power_user.persona_descriptions = {
            ...descriptions,
            [persona.avatar]: { ...descriptions[persona.avatar], lorebook: lorebook.name },
        };
    },
};
