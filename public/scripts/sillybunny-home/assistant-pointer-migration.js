import { ASSISTANT_POINTER_KEY, getAssistant } from './assistant-registry.js';

/** The account storage key that records that the pointer was moved to Reisen. */
export const ASSISTANT_POINTER_MIGRATED_KEY = 'WelcomePage_AssistantPointerMigrated';

/**
 * Moves the Welcome Page Assistant of an account to Reisen, once. Whatever it named is replaced, because the Guide is
 * only the stand-in for Reisen, and a card of the user was chosen without Reisen among the options. After that the
 * pointer is the account's to change.
 *
 * It waits for Reisen's card: pointing at a card that does not exist would make the pointer stale, and the next start
 * would find the account already migrated.
 * @param {object} options
 * @param {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void }} options.storage Account storage.
 * @param {(assistant: import('./assistant-registry.js').AssistantEntry) => string | null | undefined} options.findAvatar
 *   The avatar that the card of the assistant has in the library, or nothing when the library has no such card.
 * @returns {'already-done' | 'waiting' | 'migrated'}
 */
export function migrateAssistantPointer({ storage, findAvatar }) {
    if (storage.getItem(ASSISTANT_POINTER_MIGRATED_KEY) !== null) {
        return 'already-done';
    }
    const avatar = findAvatar(getAssistant('reisen'));
    if (!avatar) {
        return 'waiting';
    }
    // The pointer comes first: a start that stops between the two writes repeats the migration instead of skipping it.
    storage.setItem(ASSISTANT_POINTER_KEY, avatar);
    storage.setItem(ASSISTANT_POINTER_MIGRATED_KEY, 'true');
    return 'migrated';
}
