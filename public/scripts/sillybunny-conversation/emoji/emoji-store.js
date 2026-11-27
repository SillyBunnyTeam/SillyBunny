/**
 * Where the recents are kept: two lists in the mode's object of `settings.json`, so that they follow the user between
 * devices. `recentEmoji` is every emoji the user picked in the chooser, from the composer or from More Reactions, and feeds
 * its Recent section. `recentReactions` is only the emoji that were put on a message, and feeds the quick row.
 *
 * They are not keys of `DEFAULT_SETTINGS`: those are single values, and `describeSettingWrite()` turns any other value into text.
 */

import { getConversationStore, persistConversationStore } from '../context.js';
import { pushRecent, readRecents } from './emoji-recents.js';

const CHOOSER_KEY = 'recentEmoji';
const REACTIONS_KEY = 'recentReactions';

function readList(key) {
    return readRecents(getConversationStore()[key]);
}

function pushToList(key, entry) {
    const store = getConversationStore();
    const before = readRecents(store[key]);
    const after = pushRecent(before, entry);
    if (after === before) {
        return before;
    }
    store[key] = after;
    persistConversationStore();
    return after;
}

export const readRecentEmoji = () => readList(CHOOSER_KEY);
export const pushRecentEmoji = entry => pushToList(CHOOSER_KEY, entry);
export const readRecentReactions = () => readList(REACTIONS_KEY);
export const pushRecentReaction = entry => pushToList(REACTIONS_KEY, entry);
