import { setUserAvatar } from '../personas.js';
import { getConversationPersonaId } from './context.js';

export async function switchConversationPersona(personaId) {
    const targetPersonaId = getConversationPersonaId(personaId);
    if (!targetPersonaId) {
        return false;
    }

    if (targetPersonaId !== getConversationPersonaId()) {
        await setUserAvatar(targetPersonaId, { toastPersonaNameChange: false });
    }
    return targetPersonaId === getConversationPersonaId();
}
