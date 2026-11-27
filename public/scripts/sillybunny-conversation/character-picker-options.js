import { characters, getMobileThumbnailUrl } from '../../script.js';
import { tag_map, tags } from '../tags.js';
import { createLazyImage } from '../sillybunny-editor/lazy-image.js';
import { buildLibraryItems, listTagChips, matchesAllTags } from './character-library.js';

/** The roleplay list's batch is 50 as well, so the pickers show as many rows as a first page of that list. */
export const CHARACTER_PICKER_PAGE_SIZE = 50;

/**
 * What `openPicker` and `mountPicker` need to list the characters of the library at any size: items sorted with
 * favourites first and keyed by avatar file, batches of 50 with a Show More row, a search that filters on each key, and a
 * filter of the tags that the listed characters carry. The picture of a row is the small thumbnail, made only when the row
 * is first built.
 * @param {{ exclude?: ReadonlySet<string>|string[] }} [options] Avatar files to leave out, such as the members that are in a group already.
 */
export function getCharacterPickerOptions({ exclude = [] } = {}) {
    const left = new Set(exclude);
    const cards = (Array.isArray(characters) ? characters : []).filter(card => !left.has(card?.avatar));
    const items = buildLibraryItems(cards, { tagMap: tag_map }).map(item => ({
        ...item,
        icon: () => createLazyImage(getMobileThumbnailUrl('avatar', item.value), 'sb-conversation-picker-avatar'),
    }));
    const chips = listTagChips(items, tags);
    return {
        items,
        pageSize: CHARACTER_PICKER_PAGE_SIZE,
        searchDelay: 0,
        filter: chips.length ? { label: 'Tags', items: chips, match: matchesAllTags } : null,
    };
}
