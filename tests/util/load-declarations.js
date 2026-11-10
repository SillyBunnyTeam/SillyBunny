import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const modules = new Map();

/**
 * Source text and syntax tree of a browser module. Each file is parsed once and shared by all callers,
 * so treat the result as read-only.
 * @param {string} file Path relative to public/, for example 'scripts/sse-stream.js'
 * @returns {{source: string, ast: import('acorn').Program}}
 */
export function readClientModule(file) {
    if (!modules.has(file)) {
        const source = readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8');
        modules.set(file, { source, ast: parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) });
    }
    return modules.get(file);
}

/**
 * Runs named top-level declarations of a browser module in a vm context. The module is not imported,
 * because importing script.js or its neighbours starts the whole browser application.
 * A class, let or const declared this way is not a property of the context object. Read it with vm.runInContext.
 * @param {vm.Context} context Context made with vm.createContext
 * @param {string} file Path relative to public/, for example 'scripts/sse-stream.js'
 * @param {string[]} names Names of top-level declarations, run in the given order
 * @throws {Error} When a name is not declared at the top level of the module
 */
export function loadDeclarations(context, file, names) {
    const { source, ast } = readClientModule(file);
    for (const name of names) {
        const node = ast.body.map(node => node.declaration ?? node)
            .find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
        if (!node) throw new Error(`Missing declaration: ${name}`);
        vm.runInContext(source.slice(node.start, node.end), context);
    }
}
