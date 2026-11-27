import { animation_duration } from '../script.js';
import { loadMovingUIState, power_user } from './power-user.js';
import { dragElement } from './RossAscends-mods.js';

/**
 * The key that names a zoomed avatar: its `forChar` attribute and the end of its element id. Roleplay named its zoomed avatars
 * this way before this module existed, and a position that Moving UI saved is stored under the id, so the scheme must not change.
 * @param {string} file The avatar file name, such as `Seraphina.png`.
 * @returns {string}
 */
export function getZoomedAvatarKey(file) {
    return file.replace('.png', '');
}

/**
 * Compares the attribute itself, because a file name may hold a quote, which an attribute selector would need escaped.
 * @param {(key: string) => boolean} isWanted
 * @returns {JQuery}
 */
function findZoomedAvatars(isWanted) {
    return $('.zoomed_avatar[forChar]').filter((_, element) => isWanted($(element).attr('forChar')));
}

/**
 * Opens the zoomed avatar of a picture, or closes it when it is already open. Roleplay and conversation mode both call this,
 * so the window, its key and its place are the same in both modes.
 * @param {object} avatar
 * @param {string} avatar.file The avatar file name; it gives the key (`getZoomedAvatarKey`).
 * @param {string} [avatar.src] The picture to show. Defaults to the character card's own picture.
 */
export function toggleZoomedAvatar({ file, src = `/characters/${encodeURIComponent(file)}` }) {
    const key = getZoomedAvatarKey(file);

    // Without Moving UI there is one place for a zoomed avatar, so a second one would sit on the first.
    if (!power_user.movingUI) {
        findZoomedAvatars(openKey => openKey !== key).remove();
    }

    const open = findZoomedAvatars(openKey => openKey === key);
    if (open.length) {
        open.fadeOut(animation_duration, () => open.remove());
        return;
    }

    const element = $($('#zoomed_avatar_template').html());
    element.attr('forChar', key);
    element.attr('id', `zoomFor_${key}`);
    element.addClass('draggable');
    element.find('.drag-grabber').attr('id', `zoomFor_${key}header`);
    const image = element.find('.zoomed_avatar_img');
    image.attr('src', src);
    image.attr('data-izoomify-url', src);
    image.on('dragstart', event => event.preventDefault());
    element.find('.dragClose').on('click touchend', () => {
        element.fadeOut(animation_duration, () => element.remove());
    });

    $('body').append(element);
    element.fadeIn(animation_duration);
    loadMovingUIState();
    element.css('display', 'flex');
    dragElement(element);

    if (power_user.zoomed_avatar_magnification) {
        element.find('.zoomed_avatar_container').izoomify();
    }
}
