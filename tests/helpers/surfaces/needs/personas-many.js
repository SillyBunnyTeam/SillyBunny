/**
 * Five personas: the avatar files are uploaded to the server, and their names, descriptions, one title and the default
 * are in the account settings. See `index.js` for the shape of a need module.
 */

import { sentences, uploadPersonaAvatar } from '../need-kit.js';

/**
 * `personas` lists avatar, name, description and title. `longDescriptionAvatar` has a description of about 2,000
 * characters, `titledAvatar` has a title, and `defaultAvatar` is the default persona.
 */
const personas = [
    { avatar: 'audit-personas-1.png', name: 'Audit Persona One', description: 'The default persona of the audit.', title: '' },
    { avatar: 'audit-personas-2.png', name: 'Audit Persona Two With A Rather Long Name', description: sentences(40, 2).slice(0, 2000), title: '' },
    { avatar: 'audit-personas-3.png', name: 'Audit Persona Three', description: 'A persona with a title.', title: 'Court Cartographer' },
    { avatar: 'audit-personas-4.png', name: 'Audit Persona Four', description: sentences(2, 4), title: '' },
    { avatar: 'audit-personas-5.png', name: 'Audit Persona Five', description: sentences(1, 5), title: '' },
];

export const fixture = Object.freeze({
    personas: Object.freeze(personas.map(persona => Object.freeze(persona))),
    defaultAvatar: personas[0].avatar,
    longDescriptionAvatar: personas[1].avatar,
    titledAvatar: personas[2].avatar,
});

export default {
    async exists({ post }) {
        const avatars = await (await post('/api/avatars/get', { data: {} })).json();
        return fixture.personas.every(persona => avatars.includes(persona.avatar));
    },
    async seed({ post }) {
        const avatars = await (await post('/api/avatars/get', { data: {} })).json();
        const missing = fixture.personas.filter(persona => !avatars.includes(persona.avatar));
        for (const persona of missing) {
            await uploadPersonaAvatar(post, persona.avatar);
        }
        return `${missing.length} persona avatars`;
    },
    settings(settings) {
        for (const persona of fixture.personas) {
            settings.power_user.personas = { ...settings.power_user.personas, [persona.avatar]: persona.name };
            settings.power_user.persona_descriptions = {
                ...settings.power_user.persona_descriptions,
                [persona.avatar]: {
                    description: persona.description, position: 0, depth: 2, role: 0, lorebook: '', title: persona.title, appendices: [], activeAppendices: {},
                },
            };
        }
        settings.power_user.default_persona = fixture.defaultAvatar;
    },
};
