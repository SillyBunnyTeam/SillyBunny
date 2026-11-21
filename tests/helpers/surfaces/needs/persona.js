/** A persona: its avatar file on the server, and its name and description in the account settings. See `index.js` for the shape of a need module. */

import { readFileSync } from 'node:fs';

const IMAGE = readFileSync(new URL('../../../../public/img/ai4.png', import.meta.url));

export const fixture = Object.freeze({
    name: 'Audit Persona',
    avatar: 'audit-persona.png',
    description: 'A fixture persona for the UI audit.',
});

export default {
    async exists({ post }) {
        const avatars = await (await post('/api/avatars/get', { data: {} })).json();
        return avatars.includes(fixture.avatar);
    },
    async seed({ post }) {
        await post('/api/avatars/upload', {
            multipart: { avatar: { name: fixture.avatar, mimeType: 'image/png', buffer: IMAGE }, overwrite_name: fixture.avatar },
        });
        return `persona avatar ${fixture.avatar}`;
    },
    settings(settings) {
        settings.power_user.personas = { ...settings.power_user.personas, [fixture.avatar]: fixture.name };
        settings.power_user.persona_descriptions = {
            ...settings.power_user.persona_descriptions,
            [fixture.avatar]: {
                description: fixture.description, position: 0, depth: 2, role: 0, lorebook: '', title: '', appendices: [], activeAppendices: {},
            },
        };
    },
};
