export function isAbortLikeError(error, signal = null) {
    return Boolean(
        signal?.aborted ||
        error?.name === 'AbortError' ||
        /abort|cancel/i.test(String(error?.message ?? error ?? '')),
    );
}
