export const IMPERSONATION_FORMATS = Object.freeze({
    DEFAULT: 'default',
    NEUTRAL: 'neutral',
});

export function normalizeImpersonationFormat(format) {
    return String(format ?? '').trim().toLowerCase() === IMPERSONATION_FORMATS.NEUTRAL
        ? IMPERSONATION_FORMATS.NEUTRAL
        : IMPERSONATION_FORMATS.DEFAULT;
}

export function isNeutralImpersonationFormat(format) {
    return normalizeImpersonationFormat(format) === IMPERSONATION_FORMATS.NEUTRAL;
}

export function shouldUseAssistantImpersonationPrefill(type, format) {
    return type === 'impersonate' && !isNeutralImpersonationFormat(format);
}

export function shouldAppendImpersonationNamePrompt({ isInstruct, isImpersonate, isContinue, neutralImpersonate }) {
    return !isInstruct && isImpersonate && !isContinue && !neutralImpersonate;
}
