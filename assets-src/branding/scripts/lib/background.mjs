/**
 * Decides what to ask the API for as a background. The prompt text is the single source of truth: a template whose
 * `background` variable says "transparent" gets a transparent PNG from OpenAI, and anything else gets no API option.
 * An explicit `--background` must agree with the prompt, so the picture can never be asked for two different things.
 * @param {{ requested?: string, provider: string, promptBackground?: string }} input
 * @returns {string | undefined} the value for the API's `background` field, if any
 */
export function resolveBackground({ requested, provider, promptBackground }) {
    const promptIsTransparent = /transparent/i.test(promptBackground ?? '');
    const asked = requested === 'auto' ? undefined : requested;
    if (asked === 'transparent' && promptBackground && !promptIsTransparent) {
        throw new Error(`The prompt asks for "${promptBackground}" but --background transparent was passed. Change one of them.`);
    }
    if (asked === 'opaque' && promptIsTransparent) {
        throw new Error('--background opaque was passed but the prompt asks for a transparent background. Change one of them.');
    }
    const effective = asked ?? (promptIsTransparent ? 'transparent' : undefined);
    if (effective === 'transparent' && provider !== 'openai') {
        throw new Error('Gemini has no transparent output. Use --vars background="flat pure green #00FF00" and key the green out with key-bg.mjs afterwards.');
    }
    return effective;
}
