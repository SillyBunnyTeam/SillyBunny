import { characters, extension_prompt_roles, getMaxPromptTokens, unshallowCharacter } from '../../script.js';
import { power_user } from '../power-user.js';
import { checkWorldInfo, world_info_include_names } from '../world-info.js';
import { TRANSCRIPT_MESSAGE_LIMIT } from './constants.js';
import { getConversationPersonaName } from './personas.js';

const EMPTY_CONVERSATION_WORLD_INFO = Object.freeze({
    before: '',
    after: '',
    authorsNoteBefore: '',
    authorsNoteAfter: '',
    depth: Object.freeze([]),
});

function findCharacterIndex(avatar) {
    return characters.findIndex(character => character?.avatar === avatar);
}

function getConversationPromptRole(role) {
    switch (role) {
        case extension_prompt_roles.USER:
            return 'user';
        case extension_prompt_roles.ASSISTANT:
            return 'assistant';
        default:
            return 'system';
    }
}

/**
 * Builds the World Info scan lines from the messages a Conversation prompt sends.
 * @param {object[]} messages Thread messages, oldest first.
 * @param {boolean} [includeNames] Whether lines start with the speaker name.
 * @returns {string[]} Message text, newest first.
 */
export function buildConversationWorldInfoScanChat(messages, includeNames = world_info_include_names) {
    return (Array.isArray(messages) ? messages : [])
        .slice(-TRANSCRIPT_MESSAGE_LIMIT)
        .map((message) => {
            const text = String(message?.mes ?? '').trim();
            const name = String(message?.name ?? '').trim();
            return text && includeNames && name ? `${name}: ${text}` : text;
        })
        .filter(Boolean)
        .reverse();
}

/**
 * Scans lorebooks for one Conversation reply with the World Info settings that Roleplay uses.
 * The scan reads the speaker's linked books, the global books, the persona's book and the
 * thread's Lorebook Override, and it does not change the Roleplay chat. A failed scan logs a
 * warning and returns no entries, so the reply is still generated.
 * @param {object[]} messages Thread messages that the prompt sends, oldest first.
 * @param {object} settings Conversation settings of the reply.
 * @param {object} options
 * @param {string} options.avatar Avatar of the character who replies.
 * @param {string} options.personaId Persona that the user speaks as.
 * @param {string} [options.trigger] Generation type that entry trigger filters match.
 * @returns {Promise<{ before: string, after: string, authorsNoteBefore: string, authorsNoteAfter: string, depth: { depth: number, role: string, content: string }[] }>}
 */
export async function getConversationWorldInfo(messages, settings, { avatar, personaId, trigger = 'normal' } = {}) {
    if (settings?.lorebooks_enabled === false || findCharacterIndex(avatar) < 0) {
        return EMPTY_CONVERSATION_WORLD_INFO;
    }

    const persona = power_user?.persona_descriptions?.[personaId];
    try {
        // A lazy-loaded card leaves out its linked book until the full card is fetched.
        await unshallowCharacter(findCharacterIndex(avatar));
        const characterId = findCharacterIndex(avatar);
        const character = characters[characterId];
        if (!character) {
            return EMPTY_CONVERSATION_WORLD_INFO;
        }

        // The Conversation reply limit is a cap that can be larger than the main API context, not room
        // kept free in it, so the budget uses the prompt size that a Roleplay reply scans with.
        const result = await checkWorldInfo(buildConversationWorldInfoScanChat(messages), getMaxPromptTokens(), true, {
            personaDescription: String(persona?.description ?? ''),
            characterDescription: String(character.description ?? ''),
            characterPersonality: String(character.personality ?? ''),
            characterDepthPrompt: String(character.data?.extensions?.depth_prompt?.prompt ?? ''),
            scenario: String(character.scenario ?? ''),
            creatorNotes: String(character.data?.creator_notes ?? ''),
            trigger,
        }, {
            characterId,
            chatWorld: String(settings?.lorebook_override ?? ''),
            personaWorld: String(persona?.lorebook ?? ''),
            userName: getConversationPersonaName(personaId, 'User'),
        });

        return {
            before: result.worldInfoBefore,
            after: result.worldInfoAfter,
            authorsNoteBefore: result.ANBeforeEntries.join('\n'),
            authorsNoteAfter: result.ANAfterEntries.join('\n'),
            depth: result.WIDepthEntries.map(entry => ({
                depth: entry.depth,
                role: getConversationPromptRole(entry.role),
                content: entry.entries.join('\n'),
            })),
        };
    } catch (error) {
        console.warn('Conversation Mode: World Info scan failed', error);
        return EMPTY_CONVERSATION_WORLD_INFO;
    }
}
