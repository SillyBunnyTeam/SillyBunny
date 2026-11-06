/**
 * The hand-picked third-party CSS themes that Bundled Extras may install, and nothing else. The route fetches
 * only from this list: a request names an id, never a URL.
 *
 * Each entry pins one file of a public repository to a commit and to the SHA-256 of the file's bytes:
 *
 *     'theme-id': {
 *         url: 'https://raw.githubusercontent.com/<owner>/<repo>/<40-character commit>/<path>.json',
 *         sha256: '<64 lowercase hex characters>',
 *     },
 *
 * Before an entry is added, the theme is reviewed at the pinned commit: its `custom_css` has no `@import` and no
 * remote `url()`. That review is the only gate, because Install does not ask the way the in-app importer does.
 *
 * @typedef {object} BundledThemeSource
 * @property {string} url
 * @property {string} sha256
 */

/** @type {Readonly<Record<string, Readonly<BundledThemeSource>>>} */
export const BUNDLED_THEMES = Object.freeze({});

const ALLOWED_HOST = 'raw.githubusercontent.com';
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `/<owner>/<repo>/<commit>/<file path>`: a commit is pinned, a branch name is not. */
const PINNED_PATH_PATTERN = /^\/[^/]+\/[^/]+\/[0-9a-f]{40}\/[^/].*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Stops the server from starting with an entry that could fetch from the wrong place or skip the hash check.
 * @param {Record<string, BundledThemeSource>} allowlist
 * @throws {Error} Naming the entry and the rule it breaks.
 */
export function assertValidAllowlist(allowlist) {
    for (const [id, entry] of Object.entries(allowlist)) {
        const fail = rule => { throw new Error(`Bundled theme "${id}": ${rule}.`); };
        if (!ID_PATTERN.test(id)) {
            fail('the id is lowercase words joined by hyphens');
        }
        let parsed;
        try {
            parsed = new URL(entry?.url);
        } catch {
            fail('the URL is missing or not a URL');
        }
        if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_HOST || parsed.port !== '') {
            fail(`the URL is https on ${ALLOWED_HOST}`);
        }
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
            fail('the URL has no credentials, query or fragment');
        }
        if (!PINNED_PATH_PATTERN.test(parsed.pathname) || parsed.href !== entry.url) {
            fail('the URL names a file at a full 40-character commit');
        }
        if (!SHA256_PATTERN.test(entry.sha256 ?? '')) {
            fail('the hash is 64 lowercase hex characters');
        }
    }
}
