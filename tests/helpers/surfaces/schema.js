/**
 * The vocabulary of the surface registry: the families, the owner classes, the fixture data a surface can need, and the
 * backends that change a page. The entries themselves live in one file per family (`settings.js`, `list.js`, and so on).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A family file is named after its family: `<family>.js`. */
export const FAMILIES = Object.freeze(['settings', 'list', 'editor', 'dialog', 'menu', 'header', 'panel', 'status', 'home', 'chat']);

/**
 * Who owns a surface's code, which decides how far a fix may go: A is SillyBunny-authored, B is upstream-origin and
 * shown inside the shell, C is a bundled extension with its own stylesheet.
 */
export const OWNER_CLASSES = Object.freeze(['A', 'B', 'C']);

export const NEED_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The fixture data a surface can need: one module per need in `needs/`, named after it. */
export const NEEDS = Object.freeze(fs.readdirSync(fileURLToPath(new URL('./needs/', import.meta.url)))
    .filter(name => name.endsWith('.js'))
    .map(name => name.slice(0, -'.js'.length))
    .sort());

export const EDITOR_TYPES = Object.freeze(['single', 'list']);

/**
 * The backends that change a page (Connections, Sampling and Presets differ between them). `api` is the value of
 * `#main_api`; `source` is the value of `#chat_completion_source` or `#textgen_type` that is picked next, where the
 * backend has one. `connector` is the connection block that the app shows for the backend (the `apiConnector` of
 * `script.js`), and `modeLabel` is the name that the Presets and Sampling pages print in their "Backend: ..." pill. A
 * surface that depends on the backend lists the ids in `backends` and reads `ctx.backend` in `open`.
 */
export const BACKENDS = Object.freeze({
    'chat-completion': { api: 'openai', source: 'openrouter', label: 'Chat Completion', connector: '#openai_api', modeLabel: 'Chat Completions' },
    'text-completion': { api: 'textgenerationwebui', source: 'ooba', label: 'Text Completion', connector: '#textgenerationwebui_api', modeLabel: 'Text Completions' },
    'novelai': { api: 'novel', source: null, label: 'NovelAI', connector: '#novel_api', modeLabel: 'NovelAI' },
    'horde': { api: 'koboldhorde', source: null, label: 'KoboldAI Horde', connector: '#kobold_horde', modeLabel: 'Kobold/Horde' },
});

export const DEFAULT_BACKEND = 'chat-completion';

/** Ids are dotted lowercase words, so that they work in file names: `settings.backend.connections`. */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
