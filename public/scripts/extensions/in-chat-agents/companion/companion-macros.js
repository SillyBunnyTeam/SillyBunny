import { substituteParams } from '../../../../script.js';
import { normalizeCompanionMacroSyntax } from './companion-shared.js';

export function resolveCompanionContentMacros(content = '', message = null) {
    return substituteParams(normalizeCompanionMacroSyntax(content), {
        name2Override: message && !message.is_user ? String(message.name ?? '').trim() || undefined : undefined,
        original: String(message?.mes ?? ''),
    });
}
