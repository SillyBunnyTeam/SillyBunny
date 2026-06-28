import { substituteParams } from '../../../../script.js';

export function resolveCompanionContentMacros(content = '', message = null) {
    return substituteParams(content, {
        name2Override: String(message?.name ?? '').trim(),
        original: String(message?.mes ?? ''),
    });
}
