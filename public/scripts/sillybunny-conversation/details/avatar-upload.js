/**
 * Choosing a picture for a group. The server takes a PNG, JPEG, GIF or WebP file of at most 5 MiB; the picture is shown in a
 * circle, so it is cropped to a square and scaled down here before it is sent, which keeps the upload small.
 */

const ACCEPTED_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const AVATAR_SIDE = 512;

function readImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('The file is not a picture that the browser can read.'));
        };
        image.src = url;
    });
}

/**
 * @param {File} file
 * @returns {Promise<string>} A `data:image/png;base64,` URL of the middle square of the picture, at most 512 pixels wide.
 * @throws {Error} For a file that is not one of the accepted picture types, or that the browser cannot read.
 */
export async function toAvatarDataUrl(file) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new Error('Choose a PNG, JPEG, GIF or WebP picture.');
    }
    const image = await readImage(file);
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const size = Math.min(AVATAR_SIDE, side);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/png');
}

/**
 * Opens the file chooser. Resolves with the file the user picked, or null when they cancel.
 * The input stays in the document while the chooser is open, because WebKit can collect a detached input before its `change` fires.
 * @returns {Promise<File|null>}
 */
export function chooseAvatarFile() {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = ACCEPTED_TYPES.join(',');
        input.hidden = true;
        const finish = (file) => {
            input.remove();
            resolve(file);
        };
        input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', () => finish(null), { once: true });
        document.body.append(input);
        input.click();
    });
}
