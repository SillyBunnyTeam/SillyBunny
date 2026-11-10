/**
 * A tinted box that stands where artwork goes, and is all there is to see where the art has no file. Its name is its size
 * key in `sillybunny-home.css` and what a spec finds it by; it is never shown as text.
 * @param {string} name For example `row-reisen`.
 * @returns {HTMLDivElement}
 */
export function createArtPlaceholder(name) {
    const art = document.createElement('div');
    art.className = 'sbHomeArt';
    art.dataset.sbArtPlaceholder = name;
    art.setAttribute('aria-hidden', 'true');
    return art;
}
