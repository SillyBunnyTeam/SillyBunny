export const KINDS = [
    ['solo', 'Characters'],
    ['group', 'Groups'],
    ['orphan', 'Orphaned'],
];

export const ORPHAN_REASONS = [
    ['', 'Any reason'],
    ['missing-character', 'Missing character'],
    ['missing-group', 'Missing group'],
    ['unlinked-group', 'Unlinked group'],
    ['root', 'Root file'],
];

export const SORT_KEYS = ['recent', 'oldest', 'size', 'smallest', 'count', 'fewest', 'name', 'name-reverse', 'owner'];

export const LIST_PAGE_SIZE = 100;
export const MESSAGE_PAGE_SIZE = 100;
export const NAVIGATION_TIMEOUT_MS = 15_000;
export const LAST_VIEW_SAVE_DELAY_MS = 500;
export const SEARCH_DEBOUNCE_MS = 150;
export const SEARCH_CONTENT_DEBOUNCE_MS = 600;
export const MAX_ORGANIZATION_IMPORT_BYTES = 5 * 1024 * 1024;
export const RAW_PREVIEW_CHARS = 200_000;
export const UNFILED_VALUE = '__sbca_unfiled__';
/** Below this root width, or on a phone viewport, locations, chats and a chat are separate pages. */
export const COLLAPSE_WIDTH = 400;
