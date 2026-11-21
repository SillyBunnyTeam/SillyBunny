/**
 * Whether the shell takes Command, and not Control, as its shortcut modifier.
 * @param {{ platform?: string }} [navigatorLike]
 * @returns {boolean}
 */
export function isApplePlatform(navigatorLike = globalThis.navigator) {
    return Boolean(navigatorLike?.platform?.toUpperCase().includes('MAC'));
}
