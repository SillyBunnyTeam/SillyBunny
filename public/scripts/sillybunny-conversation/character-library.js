/**
 * The characters of the library as the items of the character pickers: sorted, keyed by the card's avatar file, with a
 * search key made once. No DOM and no imports, so that the order and the filter are tested without a page.
 */

// The same collation as the assistant picker, so a character has one place in every list of names.
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' });

/**
 * Whether a card is a favourite, read as the roleplay list reads it: the card's `fav`, or the extension field of its data.
 * @param {Record<string, any>|null} card
 * @returns {boolean}
 */
export function isFavoriteCard(card) {
    const flag = value => value === true || value === 'true';
    return flag(card?.fav) || flag(card?.data?.extensions?.fav);
}

/**
 * @typedef {object} LibraryItem
 * @property {string} value The card's avatar file name.
 * @property {string} label The name on the card.
 * @property {string} searchText The name in lower case; a query is matched against it.
 * @property {boolean} favorite
 * @property {string[]} tagIds
 */

/**
 * Favourites first, then by name, then by avatar file so that the order is total.
 * @param {Array<Record<string, any>|null>} cards
 * @param {{ tagMap?: Record<string, string[]|null> }} [options] `tagMap` maps an avatar file to the ids of its tags.
 * @returns {LibraryItem[]}
 */
export function buildLibraryItems(cards, { tagMap = {} } = {}) {
    const items = [];
    for (const card of cards) {
        if (!card?.avatar) continue;
        const label = card.name || 'Character';
        const tagIds = tagMap[card.avatar];
        items.push({
            value: card.avatar,
            label,
            searchText: label.toLocaleLowerCase(),
            favorite: isFavoriteCard(card),
            tagIds: Array.isArray(tagIds) ? tagIds : [],
        });
    }
    return items.sort((a, b) => Number(b.favorite) - Number(a.favorite)
        || NAME_COLLATOR.compare(a.label, b.label)
        || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

/**
 * The tags that at least one of the items carries, by name, as the chips of a filter.
 * @param {LibraryItem[]} items
 * @param {Array<{ id: string, name: string, color?: string }>} tags Every tag of the app.
 * @returns {Array<{ value: string, label: string, color: string }>}
 */
export function listTagChips(items, tags) {
    const used = new Set();
    for (const item of items) {
        for (const id of item.tagIds) used.add(id);
    }
    return tags
        .filter(tag => used.has(tag.id))
        .map(tag => ({ value: tag.id, label: tag.name, color: tag.color || '' }))
        .sort((a, b) => NAME_COLLATOR.compare(a.label, b.label));
}

/**
 * The roleplay list's rule for selected tags: a character stays when it has all of them.
 * @param {LibraryItem} item
 * @param {ReadonlySet<string>} selected
 * @returns {boolean}
 */
export function matchesAllTags(item, selected) {
    for (const id of selected) {
        if (!item.tagIds.includes(id)) return false;
    }
    return true;
}
