/**
 * Where a rendered string comes from, for the copy check of the surface audit. The page shows a label or user data, and the audit must
 * judge the labels only; of the labels, the ones that upstream wrote are not the project's to change.
 *
 * - `foreign`: only code that the project does not own (quick-image-gen, third-party extensions, extension libraries, the bundled agent templates) holds the text.
 * - `data`: no file of the working tree holds the text, so the app made it at run time from data (a name, a file, a model id); or it has
 *   the shape of an identifier (`eye-slash`, an icon name), or the app picks it at random from a list.
 * - `upstream`: the text is in the upstream base commit, which is verbatim upstream wording even where a SillyBunny file repeats it.
 * - `sillybunny`: any other label.
 *
 * A text that fills the holes of a template ("Actions for ${name}") is judged as the template, so the user's data in the hole is never
 * judged. The sets come from `scripts/copy-strings.js`.
 */

import { stringLookup, treeStrings, upstreamStrings } from '../../scripts/copy-strings.js';
const norm = text => String(text).replace(/\s+/g, ' ').trim();

/** Titles that the app picks from a list at random each time (the empty Characters page), so a record of one would come and go. */
const ROTATING = new Set(['Here be dragons', 'Otterly empty', 'Kiwibunga', 'Pump-a-Rum', 'Croak it']);
/** An icon name (`eye-slash`, `filter-list`) or a path (`/user/files/x`) is code, whatever file holds it. */
const IDENTIFIER = /^(?:[a-z][a-z0-9]*(?:-[\w${}]+)*|\/[\w./${}-]+)$/;

export const ORIGINS = Object.freeze(['foreign', 'data', 'upstream', 'sillybunny']);

/**
 * @param {{ tree?: { strings: string[], foreign: string[], content?: string[] }, upstream?: { strings: string[] } | null }} [sets] The sets to read; the
 *   defaults are built (and cached) from the working tree and the upstream base commit.
 */
export function createOrigin({ tree = treeStrings(), upstream } = {}) {
    const own = stringLookup(tree.strings);
    const foreign = stringLookup(tree.foreign);
    const foreignText = new Set(tree.foreign.map(norm));
    const content = new Set(tree.content ?? []);
    let upstreamLookup = null;
    let upstreamFailed = null;
    const upstreamOf = () => {
        if (!upstreamLookup && !upstreamFailed) {
            try {
                upstreamLookup = stringLookup((upstream ?? upstreamStrings()).strings);
            } catch (error) {
                upstreamFailed = error;
            }
        }
        return upstreamLookup;
    };
    return {
        /**
         * @param {string} text A rendered string.
         * @returns {{ origin: 'foreign' | 'data' | 'upstream' | 'sillybunny' | 'unknown', text: string }} `text` is the string to judge: the
         *   template when the text fills one. `unknown` means that the upstream set could not be built, so a label is `unknown` and not
         *   `sillybunny`.
         */
        classify(text) {
            // An icon name ("eye-slash") or another identifier is named by its shape, whatever file holds it.
            if (IDENTIFIER.test(text) || ROTATING.has(norm(text))) {
                return { origin: 'data', text };
            }
            if (content.has(norm(text))) {
                return { origin: 'data', text };
            }
            const label = own(text);
            if (!label) {
                return { origin: foreign(text) ? 'foreign' : 'data', text };
            }
            // A template of the project's own files ("${} left") can make a name that only code it does not own holds (an emoji name): the name is that code's wording.
            if (label.includes('${}') && foreignText.has(norm(text))) {
                return { origin: 'foreign', text };
            }
            const lookup = upstreamOf();
            if (!lookup) {
                return { origin: 'unknown', text: label };
            }
            return { origin: lookup(label) ? 'upstream' : 'sillybunny', text: label };
        },
        get upstreamError() {
            return upstreamFailed;
        },
    };
}
