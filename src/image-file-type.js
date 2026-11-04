import { Buffer } from 'node:buffer';

// The server serves a stored file with the content type that its extension names, so a file from an upload or an
// archive may keep its extension only when the extension names an image type and the leading bytes are that type.

const hasBytesAt = (buffer, offset, bytes) => buffer.subarray(offset, offset + bytes.length).equals(Buffer.from(bytes, 'latin1'));
const isPng = buffer => hasBytesAt(buffer, 0, '\x89PNG\r\n\x1A\n');
const isJpeg = buffer => hasBytesAt(buffer, 0, '\xFF\xD8\xFF');

const IMAGE_TYPES = [
    { extensions: ['.png', '.apng'], matches: isPng },
    { extensions: ['.jpg', '.jpeg', '.jfif'], matches: isJpeg },
    { extensions: ['.gif'], matches: buffer => hasBytesAt(buffer, 0, 'GIF8') },
    { extensions: ['.webp'], matches: buffer => hasBytesAt(buffer, 0, 'RIFF') && hasBytesAt(buffer, 8, 'WEBP') },
    { extensions: ['.avif'], matches: buffer => hasBytesAt(buffer, 4, 'ftypavif') || hasBytesAt(buffer, 4, 'ftypavis') },
    { extensions: ['.bmp'], matches: buffer => hasBytesAt(buffer, 0, 'BM') },
];

/**
 * Checks that a file is an image of the type that its extension names.
 * @param {string} extension File extension with its dot, in any case
 * @param {Buffer|undefined} buffer File content, or at least its leading bytes
 * @returns {boolean} True if the extension names an image type and the leading bytes are that type
 */
export function isImageFile(extension, buffer) {
    const type = IMAGE_TYPES.find(({ extensions }) => extensions.includes(String(extension).toLowerCase()));
    return Boolean(type) && Buffer.isBuffer(buffer) && type.matches(buffer);
}
