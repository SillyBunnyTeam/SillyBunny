/** The parity rules of every family that has them: the nine families of the registry except `chat`. */

import { rules as dialog } from './dialog.js';
import { rules as editor } from './editor.js';
import { rules as header } from './header.js';
import { rules as home } from './home.js';
import { rules as list } from './list.js';
import { rules as menu } from './menu.js';
import { rules as panel } from './panel.js';
import { rules as settings } from './settings.js';
import { rules as status } from './status.js';

export const PARITY_FAMILIES = Object.freeze(['settings', 'list', 'editor', 'dialog', 'menu', 'header', 'panel', 'status', 'home']);

/** @type {Readonly<Record<string, any>>} */
export const RULES = Object.freeze({ settings, list, editor, dialog, menu, header, panel, status, home });

/** The viewports that the census measures every surface at, when the surface has them. */
export const PARITY_VIEWPORTS = Object.freeze(['1440x900', '390x844']);
