/**
 * The name that upstream gives the user until they choose one (`default_user_name` in script.js, which does not export it).
 */
export const DEFAULT_USER_NAME = 'User';

/** The name that `addMissingPersonas` in personas.js gives an avatar that no persona was bound to. */
export const UNNAMED_PERSONA_NAME = '[Unnamed Persona]';

const UNCHOSEN_PERSONA_NAMES = new Set([DEFAULT_USER_NAME, UNNAMED_PERSONA_NAME]);

/**
 * Whether the account still has the persona it was born with. That is the default user name on a persona that has
 * nothing else of the user's in it. The app binds an avatar without a persona to the unnamed persona with empty fields
 * on boot, so a missing persona entry, the unnamed persona and one that holds only the default name all count.
 * A persona that the user created and named "User" without anything else cannot be told apart from it.
 * @param {object} persona
 * @param {string} persona.avatarId The avatar file of the current persona.
 * @param {string} persona.userName The current user name.
 * @param {object} deps
 * @param {Record<string, any>} deps.powerUser
 * @returns {boolean}
 */
export function isUntouchedDefaultPersona({ avatarId, userName }, { powerUser }) {
    if (userName !== DEFAULT_USER_NAME || powerUser.default_persona === avatarId) {
        return false;
    }
    const boundName = powerUser.personas?.[avatarId];
    if (boundName !== undefined && !UNCHOSEN_PERSONA_NAMES.has(boundName)) {
        return false;
    }
    const descriptor = powerUser.persona_descriptions?.[avatarId] ?? {};
    const holdsText = value => String(value ?? '').trim() !== '';
    const holdsItems = value => Array.isArray(value) && value.length > 0;
    return !(holdsText(descriptor.description) || holdsText(descriptor.title) || holdsText(descriptor.lorebook)
        || holdsItems(descriptor.connections) || holdsItems(descriptor.appendices));
}

/**
 * Binds the name that the user gave in Welcome to their persona. It writes what the first-run onboarding popup of
 * upstream wrote: the user name, the name of the persona that belongs to the avatar, and an empty description that
 * sits in the prompt. The writes are saved by the callers' own debounce.
 * @param {object} persona
 * @param {string} persona.avatarId The avatar file of the current persona.
 * @param {string | undefined} persona.name What the user typed.
 * @param {object} deps
 * @param {(name: string) => void} deps.setUserName
 * @param {{ personas: Record<string, string>, persona_descriptions: Record<string, { description: string, position: number }> }} deps.powerUser
 * @param {{ IN_PROMPT: number }} deps.positions
 * @returns {boolean} Whether a persona was written. A name with nothing in it writes nothing.
 */
export function savePersonaName({ avatarId, name }, { setUserName, powerUser, positions }) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
        return false;
    }
    const userName = trimmed.replace('\n', ' ');
    setUserName(userName);
    powerUser.personas[avatarId] = userName;
    powerUser.persona_descriptions[avatarId] = { description: '', position: positions.IN_PROMPT };
    return true;
}
