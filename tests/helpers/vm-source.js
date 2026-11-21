import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

export const SCRIPT_URL = new URL('../../public/script.js', import.meta.url);
export const AUTO_ENGINE_URL = new URL('../../public/scripts/sillybunny-conversation/auto-engine.js', import.meta.url);
export const SLASH_COMMANDS_URL = new URL('../../public/scripts/slash-commands.js', import.meta.url);
export const POWER_USER_URL = new URL('../../public/scripts/power-user.js', import.meta.url);

const parsedSources = new Map();

function parseSource(url) {
    if (!parsedSources.has(url.href)) {
        const text = readFileSync(url, 'utf8');
        parsedSources.set(url.href, { text, ast: parse(text, { ecmaVersion: 'latest', sourceType: 'module' }) });
    }
    return parsedSources.get(url.href);
}

/**
 * Runs the real top-level functions of a browser module in a vm context. Jest cannot import `script.js` and its
 * neighbours, so tests of their guards cut the functions out of the source and stub the collaborators.
 * @param {vm.Context} context Context the functions are declared in
 * @param {string[]} names Names of the top-level functions to run
 * @param {URL} [url] Source file
 */
export function loadFunctions(context, names, url = SCRIPT_URL) {
    const { text, ast } = parseSource(url);
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node).find(node => node.id?.name === name);
        if (!node) {
            throw new Error(`${url.pathname} has no function named ${name}`);
        }
        vm.runInContext(text.slice(node.start, node.end), context);
    }
}
