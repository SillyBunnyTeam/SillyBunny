/** A sha256 made of one repeated hex digit, so each output of a sample is told apart at a glance. */
export const fakeSha = (digit) => digit.repeat(64);

const ENCODER = { sharp: '0.35.5', vips: '8.18.7', webp: '1.6.0', png: '1.6.58', 'zlib-ng': '2.3.3' };

/** A manifest with one asset of every type, valid as it stands. */
export function sampleManifest() {
    return {
        format: 1,
        encoder: { ...ENCODER },
        assets: {
            'gs-reisen': {
                type: 'still',
                key: 'home',
                master: 'reisen/gs-reisen.png',
                ratio: '1',
                frame: { mode: 'subject', margin: 2 },
                grid: [189, 372],
                rings: { rim: 2, band: 2 },
                outputs: [{ path: 'public/img/sillybunny/gs-reisen@native.webp', encoding: 'webp-lossless', sha256: fakeSha('1') }],
            },
            'splash-reisen': {
                type: 'still',
                key: 'splash',
                ratio: '1',
                frame: { mode: 'canvas' },
                grid: [281, 371],
                rings: { rim: 2, band: 2 },
                frames: {
                    idle: { master: 'reisen/splash-reisen--idle.png', outputs: [{ path: 'public/img/sillybunny/splash-reisen--idle@native.webp', encoding: 'webp-lossless', sha256: fakeSha('2') }] },
                },
                outputs: [{ path: 'public/img/sillybunny/splash-reisen@native.webp', encoding: 'webp-lossless', from: 'idle', sha256: fakeSha('2') }],
                motion: { master: 'reisen/splash-reisen--anim.json', output: 'public/img/sillybunny/splash-reisen--anim.json', sha256: fakeSha('3') },
            },
            'hero-duo': {
                type: 'scene',
                key: 'home',
                master: 'hero-duo/hero-duo.png',
                ratio: '1',
                frame: { mode: 'subject', margin: 2 },
                grid: [384, 368],
                outputs: [{ path: 'public/img/sillybunny/hero-duo@native.webp', encoding: 'webp-lossless', sha256: fakeSha('4') }],
                backdrop: { master: 'hero-duo/hero-duo--backdrop.png', outputs: [{ path: 'public/img/sillybunny/hero-duo--backdrop@native.webp', encoding: 'webp-lossless', sha256: fakeSha('5') }] },
                layers: {
                    reisen: {
                        box: [2, 4, 201, 362],
                        pictures: {
                            'breath-c': { master: 'hero-duo/hero-duo--reisen--breath-c.png', outputs: [{ path: 'public/img/sillybunny/hero-duo--reisen--breath-c@native.webp', encoding: 'webp-lossless', sha256: fakeSha('6') }] },
                        },
                    },
                },
                compose: { pose: 'breath-c' },
                motion: { master: 'hero-duo/hero-duo--breath.json', output: 'public/img/sillybunny/hero-duo--breath.json', sha256: fakeSha('7') },
            },
            'icon-16': {
                type: 'icon',
                key: null,
                master: 'logo/logo-16.png',
                grid: [16, 16],
                outputs: [{ path: 'public/img/icon-16x16.png', encoding: 'png', sha256: fakeSha('8') }],
            },
            favicon: {
                type: 'ico',
                key: null,
                entries: ['icon-16'],
                outputs: [{ path: 'public/favicon.ico', sha256: fakeSha('9') }],
            },
            'logo-svg': {
                type: 'copy',
                key: null,
                master: 'logo/logo.svg',
                outputs: [{ path: 'public/img/sillybunny/logo.svg', sha256: fakeSha('a') }],
            },
            'greeting-tewi': {
                type: 'pair',
                key: null,
                master: 'tewi/greeting-tewi.png',
                ratio: '1',
                grid: [768, 512],
                opaque: true,
                outputs: [
                    { path: 'public/img/sillybunny/greeting-tewi.webp', encoding: 'webp-lossless', sha256: fakeSha('f') },
                    { path: 'public/img/sillybunny/greeting-tewi@2x.webp', encoding: 'webp-lossless', scale: 2, sha256: fakeSha('0') },
                ],
            },
            'greeting-reisen': {
                type: 'pinned',
                key: null,
                reason: 'No master yet.',
                checks: ['nearest-pair'],
                outputs: [
                    { path: 'public/img/sillybunny/greeting-reisen.webp', sha256: fakeSha('b') },
                    { path: 'public/img/sillybunny/greeting-reisen@2x.webp', sha256: fakeSha('c') },
                ],
            },
        },
    };
}

/** A record that passes, for the master `gs-reisen.png` with the sha256 of `fakeSha('d')`. */
export function sampleRecord() {
    return {
        format: 1,
        file: 'gs-reisen.png',
        sha256: fakeSha('d'),
        characters: ['reisen'],
        licence: 'CC-BY-NC-SA-4.0',
        made: '2026-11-01',
        models: [{ provider: 'openai', model: 'gpt-image-2.5-sunburst-h', uses: ['generate', 'edit'], first: '2026-11-01', last: '2026-11-01' }],
        references: 'own-art',
        steps: ['rim-recolour', 'pixel-snap'],
        handEdits: false,
        record: `sha256:${fakeSha('e')}`,
    };
}
