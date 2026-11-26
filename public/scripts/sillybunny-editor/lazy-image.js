/**
 * An `<img>` that is not fetched until it is shown. The browser decides whether to load a lazy image when `src` is set,
 * so `loading` has to be set first: a detached image that gets its `src` first is fetched at once, which for the rows of
 * a long picker is one request for every character of the library each time the list is built again.
 * @param {string} src
 * @param {string} [className]
 * @returns {HTMLImageElement}
 */
export function createLazyImage(src, className = '') {
    const image = document.createElement('img');
    image.className = className;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = src;
    return image;
}
