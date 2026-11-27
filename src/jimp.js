import { createJimp } from '@jimp/core';

// Optimized image formats
import webp from '@jimp/wasm-webp';
import png from '@jimp/wasm-png';
import jpeg from '@jimp/wasm-jpeg';
import avif from '@jimp/wasm-avif';

// Other image formats
import bmp, { msBmp } from '@jimp/js-bmp';
import gif from '@jimp/js-gif';
import tiff from '@jimp/js-tiff';

// SillyBunny: keep only plugins called by the server (resize) to trim boot time and module memory.
import * as resize from '@jimp/plugin-resize';

const defaultPlugins = [
    resize.methods,
];

// A custom jimp that uses WASM for optimized formats and JS for the rest
const Jimp = createJimp({
    formats: [webp, png, jpeg, avif, bmp, msBmp, gif, tiff],
    plugins: [...defaultPlugins],
});

const JimpMime = {
    bmp: bmp().mime,
    gif: gif().mime,
    jpeg: jpeg().mime,
    png: png().mime,
    tiff: tiff().mime,
    // SillyBunny: expose WebP MIME so thumbnail encoding can write WebP via @jimp/wasm-webp.
    webp: webp().mime,
};

export default Jimp;

export { Jimp, JimpMime };
