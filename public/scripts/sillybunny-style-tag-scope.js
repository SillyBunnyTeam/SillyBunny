/**
 * The node types that `decodeStyleTags()` in `chats.js` keeps inside its prefix. It prefixes the selectors of
 * `rule` and `page` nodes and walks the `rules` of grouping at-rules. The other types hold no selectors. These
 * are the types that @adobe/css-tools 4.4 parsed.
 */
const SCOPABLE_NODE_TYPES = new Set([
    'charset',
    'comment',
    'container',
    'custom-media',
    'document',
    'font-face',
    'host',
    'keyframes',
    'layer',
    'media',
    'namespace',
    'page',
    'rule',
    'starting-style',
    'supports',
]);

const DECLARATION_NODE_TYPES = new Set(['declaration', 'comment']);

/**
 * Removes the CSS that `decodeStyleTags()` cannot scope to its prefix, so that message CSS applies only inside
 * the message.
 *
 * @adobe/css-tools 4.5 gives `@property`, `@counter-style`, `@scope`, `@view-transition` and other at-rules their
 * own node types. Version 4.4 parsed them as rules with an `@` selector, and the prefix made those rules invalid,
 * so browsers ignored them. With their own types they get no prefix and apply to the whole page, so this removes
 * any node type outside the 4.4 set.
 *
 * Version 4.5 also parses nested rules inside declarations. A nested selector can put `&` inside `:has()` or
 * `:not()` and select elements outside the message. Version 4.4 rejected nested CSS as a parse error, so this
 * throws, and the caller shows a CSS error as before.
 * @param {object} node A stylesheet, or a node of it
 * @throws {Error} When a declaration block holds a nested rule or at-rule
 */
export function removeUnscopableCss(node) {
    if (Array.isArray(node.declarations) && node.declarations.some(declaration => !DECLARATION_NODE_TYPES.has(declaration?.type))) {
        throw new Error('Nested CSS rules are not supported');
    }

    if (Array.isArray(node.rules)) {
        node.rules = node.rules.filter(rule => SCOPABLE_NODE_TYPES.has(rule?.type));
        node.rules.forEach(removeUnscopableCss);
    }

    if (Array.isArray(node.keyframes)) {
        node.keyframes.forEach(removeUnscopableCss);
    }
}
