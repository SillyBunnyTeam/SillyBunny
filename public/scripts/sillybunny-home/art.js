/**
 * A box that stands where artwork will go. Its name is its size key in `sillybunny-home.css`.
 * @param {string} name For example `gs-reisen`.
 * @returns {HTMLDivElement}
 */
export function createArtPlaceholder(name) {
    const art = document.createElement('div');
    art.className = 'sbHomeArt';
    art.dataset.sbArtPlaceholder = name;
    art.setAttribute('aria-hidden', 'true');
    art.textContent = name;
    return art;
}
