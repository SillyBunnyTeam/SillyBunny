// SillyBunny: skip loading the 4-file structuredClone polyfill graph when native structuredClone exists.
if (typeof globalThis.structuredClone !== 'function') {
    const { default: structuredClone } = await import('./index.js');
    console.debug('Monkey-patching structuredClone');
    globalThis.structuredClone = structuredClone;
}
