/**
 * Shared breakpoints. Overlays (alerts, dialogs, windows, menus, pickers) become bottom sheets
 * under the AdwDialog condition; the shell layout keeps SillyBunny's own 768px breakpoint.
 * See DESIGN.md Navigation (Adaptive sizes) and Dialogs.
 */

/** libadwaita adw-dialog.c PORTRAIT_CONDITION / LANDSCAPE_CONDITION. */
export const OVERLAY_SHEET_QUERY = '(max-width: 450px), (max-height: 360px)';

/** Settings sidebar, List → Split Editor collapse, message action row, mobile-styles.css. */
export const LAYOUT_MOBILE_QUERY = '(max-width: 768px)';
