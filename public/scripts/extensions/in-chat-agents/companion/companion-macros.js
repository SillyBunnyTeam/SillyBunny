import { substituteParams } from '../../../../script.js';

const ESCAPED_MACRO_OPEN_RE = /\\\{\\\{/g;
const ESCAPED_MACRO_CLOSE_RE = /\\\}\\\}/g;
const ENTITY_OPEN_BRACE_RE = /&(?:#123|#x7b|lcub);/gi;
const ENTITY_CLOSE_BRACE_RE = /&(?:#125|#x7d|rcub);/gi;

function normalizeCompanionMacroSyntax(content = '') {
    return String(content ?? '')
        .replace(ESCAPED_MACRO_OPEN_RE, '{{')
        .replace(ESCAPED_MACRO_CLOSE_RE, '}}')
        .replace(ENTITY_OPEN_BRACE_RE, '{')
        .replace(ENTITY_CLOSE_BRACE_RE, '}');
}

export function resolveCompanionContentMacros(content = '', message = null) {
    return substituteParams(normalizeCompanionMacroSyntax(content), {
        name2Override: message && !message.is_user ? String(message.name ?? '').trim() || undefined : undefined,
        original: String(message?.mes ?? ''),
    });
}
