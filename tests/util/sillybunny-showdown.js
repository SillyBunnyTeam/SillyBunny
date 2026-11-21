import showdown from 'showdown';

import { markdownUnderscoreExt } from '../../public/scripts/showdown-underscore.js';
import { addShowdownPatch } from '../../public/scripts/util/showdown-patch.js';

// The options of the Showdown converter in reloadMarkdownProcessor() (public/script.js).
// tests/markdown-engine-wiring.test.js fails when the two lists differ.
export const SILLYBUNNY_SHOWDOWN_OPTIONS = Object.freeze({
    emoji: true,
    literalMidWordUnderscores: true,
    parseImgDimensions: true,
    tables: true,
    underline: true,
    simpleLineBreaks: true,
    strikethrough: true,
    disableForced4SpacesIndentedSublists: true,
});

/**
 * Builds the Showdown converter that SillyBunny renders chat messages with when the user picks Showdown. The
 * "Non-markdown strings" extension is left out, because it reads the user settings and adds nothing while they
 * are empty.
 * @returns {import('showdown').Converter}
 */
export function createSillyBunnyShowdownConverter() {
    addShowdownPatch(showdown);
    return new showdown.Converter({
        ...SILLYBUNNY_SHOWDOWN_OPTIONS,
        extensions: [markdownUnderscoreExt()],
    });
}
