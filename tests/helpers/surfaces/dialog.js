/**
 * The dialog family: every overlay that the shell shows in its frame (Alert, Dialog, Window), the Popups that keep their own
 * frame, and the legacy popup that extensions still call. The tier is the second segment of the id, so a tool can compare the
 * dialogs of one tier: `dialog.alert.*`, `dialog.dialog.*`, `dialog.window.*`, `dialog.own-frame.*`.
 *
 * One entry is one layout, not one call site. A Popup class (text, confirm, input, crop, display) has an entry through a
 * representative call site, and the adapters that move a caller into the frame (utility, form, preset and lorebook, window
 * content, window tools, connection manager) have an entry for each distinct layout they produce. The entries sit in the
 * `dialog-*.js` files by tier, except those of the bundled extensions, which have a file of their own; this file only joins
 * them. An entry leaves its routes and its in-page changes in place, so every entry needs a fresh page.
 */

import { surfaces as alerts } from './dialog-alert.js';
import { surfaces as extensions } from './dialog-extensions.js';
import { surfaces as forms } from './dialog-form.js';
import { surfaces as own } from './dialog-own.js';
import { surfaces as windows } from './dialog-window.js';

/** @type {import('./index.js').Surface[]} */
export const surfaces = [...alerts, ...forms, ...windows, ...extensions, ...own];
