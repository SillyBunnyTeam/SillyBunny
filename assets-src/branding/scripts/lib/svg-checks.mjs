import { gzipSync } from 'node:zlib';

// The largest a final logo SVG may be, in bytes, as the art plan asks (12 KB).
export const MAX_SVG_BYTES = 12000;

// Things an editor or an exporter leaves in an SVG that a logo file must not carry.
const METADATA = [
    [/<metadata\b/i, 'a <metadata> element'],
    [/<title\b/i, 'a <title> element'],
    [/<desc\b/i, 'a <desc> element'],
    [/<!--/, 'a comment'],
    [/<\?xml\b/i, 'an XML declaration'],
    [/<!DOCTYPE/i, 'a doctype'],
    [/\b(?:sodipodi|inkscape|rdf|dc|cc):/i, 'editor or metadata namespaces'],
    [/<(?:script|style)\b/i, 'a script or style element'],
];

/**
 * The checks every final logo SVG passes: a viewBox and no width or height on the root, no metadata, and under 12 KB.
 * Returns its size raw and gzipped, or throws saying what is wrong with which file.
 * @param {string} svg
 * @param {string} name used in the error message
 * @param {number} [limit] the size the file must stay under
 * @returns {{ bytes: number, gzipBytes: number, viewBox: number[] }}
 */
export function checkFinalSvg(svg, name, limit = MAX_SVG_BYTES) {
    const root = /^<svg\b([^>]*)>/.exec(svg);
    if (!root) {
        throw new Error(`${name} does not start with an <svg> element.`);
    }
    const viewBox = /\sviewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(root[1])?.slice(1).map(Number);
    if (!viewBox) {
        throw new Error(`${name} has no viewBox on its <svg> element.`);
    }
    if (/\s(?:width|height)=/.test(root[1])) {
        throw new Error(`${name} has a width or a height on its <svg> element; it must size itself from the viewBox only.`);
    }
    const found = METADATA.find(([pattern]) => pattern.test(svg));
    if (found) {
        throw new Error(`${name} contains ${found[1]}.`);
    }
    const bytes = Buffer.byteLength(svg);
    if (bytes >= limit) {
        throw new Error(`${name} is ${bytes} bytes, which is not under ${limit}.`);
    }
    return { bytes, gzipBytes: gzipSync(svg).length, viewBox };
}
