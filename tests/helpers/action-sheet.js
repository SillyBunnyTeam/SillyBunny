/**
 * The phone bottom sheet that is open now.
 *
 * `openActionMenu` builds one sheet per opening. When a menu item opens a second menu, the leaving
 * sheet stays in the DOM until its exit animation ends, so a bare `.sb-action-sheet` matches two
 * elements for a moment and fails in strict mode. Closing a sheet sets `hidden` on it at once
 * (the exit only adds `inert` and an inline `display`), so `:not([hidden])` excludes it for the whole
 * exit. `:visible` does not, because the exit keeps the sheet displayed.
 */
export const OPEN_ACTION_SHEET = '.sb-action-sheet:not([hidden])';
