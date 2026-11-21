/** @typedef {{ r: number, g: number, b: number }} Rgb */

/**
 * @param {string} hex like #b99bf2
 * @returns {Rgb}
 */
export function parseHex(hex) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    if (!match) {
        throw new Error(`A colour must be six hex digits after "#", such as #b99bf2, got "${hex}".`);
    }
    return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) };
}

const linear = (channel) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

/** The WCAG relative luminance. @param {Rgb} rgb */
export const luminance = ({ r, g, b }) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** The WCAG contrast ratio of two hex colours, from 1 to 21. */
export function contrastRatio(one, two) {
    const [light, dark] = [luminance(parseHex(one)), luminance(parseHex(two))].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
}
