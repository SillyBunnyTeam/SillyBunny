/**
 * Shared breakpoints. Alerts, dialogs and windows become bottom sheets under the AdwDialog condition; menus and
 * pickers become sheets under the shell layout's own 768px breakpoint (or a short window).
 * Keep dialog breakpoints shared across the editor surfaces.
 */

/** libadwaita adw-dialog.c PORTRAIT_CONDITION / LANDSCAPE_CONDITION. */
export const OVERLAY_SHEET_QUERY = '(max-width: 450px), (max-height: 360px)';

/** Settings sidebar, List → Split Editor collapse, mobile-styles.css. The set of message actions follows the pointer, not this query. */
export const LAYOUT_MOBILE_QUERY = '(max-width: 768px)';

/** Menus and pickers become bottom sheets in the mobile layout and in a window too short for a popover; alerts, dialogs and windows keep OVERLAY_SHEET_QUERY. */
export const MENU_SHEET_QUERY = `${LAYOUT_MOBILE_QUERY}, (max-height: 360px)`;

/** The bottom chat bar folds into its chip row and extension tray under the shell breakpoint, and on a touch screen too short for its rows (a phone held sideways). */
export const BOTTOM_BAR_COMPACT_QUERY = `${LAYOUT_MOBILE_QUERY}, (pointer: coarse) and (max-height: 450px)`;
