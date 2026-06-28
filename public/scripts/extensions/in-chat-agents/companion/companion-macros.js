import { substituteParams } from '../../../../script.js';

export function resolveCompanionContentMacros(content = '', message = null) {
    return substituteParams(content, {
        name2Override: message && !message.is_user ? String(message.name ?? '').trim() || undefined : undefined,
        original: String(message?.mes ?? ''),
    });
}
