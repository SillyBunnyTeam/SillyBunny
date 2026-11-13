/**
 * Shared breakpoints. Overlays (alerts, dialogs, windows, menus, pickers) become bottom sheets
 * under the AdwDialog condition; the shell layout keeps SillyBunny's own 768px breakpoint.
 * Keep dialog breakpoints shared across the editor surfaces.
 */

/** libadwaita adw-dialog.c PORTRAIT_CONDITION / LANDSCAPE_CONDITION. */
export const OVERLAY_SHEET_QUERY = '(max-width: 450px), (max-height: 360px)';

/** Settings sidebar, List → Split Editor collapse, message action row, mobile-styles.css. */
export const LAYOUT_MOBILE_QUERY = '(max-width: 768px)';

/** The overlay breakpoint, cut to where `sillybunny-mobile-shell.css` (media `max-width: 768px`) is loaded: a short window wider than 768px keeps the popover. */
export const MENU_SHEET_QUERY = '(max-width: 450px), (max-width: 768px) and (max-height: 360px)';
