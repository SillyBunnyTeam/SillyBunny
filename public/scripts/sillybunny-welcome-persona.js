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
