import { Fuse, localforage } from '../lib.js';
import { characters, chat_metadata, eventSource, event_types, generateQuietPrompt, getCurrentChatId, getRequestHeaders, getThumbnailUrl, saveMetadata, saveSettingsDebounced, this_chid } from '../script.js';
import { saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { createThumbnail, flashHighlight, getBase64Async, stringFormat, debounce, saveBase64AsFile, getFileExtension, sortIgnoreCaseAndAccents } from './utils.js';
import { debounce_timeout } from './constants.js';
import { t } from './i18n.js';
import { Popup, POPUP_RESULT } from './popup.js';
import { groups, selected_group } from './group-chats.js';
import { humanizedDateTime } from './RossAscends-mods.js';
import { deleteMediaFromServer } from './chats.js';

const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';

// SillyBunny: the folders and the file-to-folder map are upstream's, read from its image-metadata index. The gallery module
// (sillybunny-background-gallery.js) draws them as sections and owns selection, so this file keeps only the last index it read.
/** @type {{folders: Array<{id: string, name: string, thumbnailFile: string}>, imageFolderMap: Object.<string, string[]>}} */
let folderIndex = { folders: [], imageFolderMap: {} };
/** @type {{render: () => void, setQuery: (value: string) => void, setIndex: (index: object) => void, filesRemoved: (files: string[]) => void}|null} */
let galleryHost = null;

// A single transparent PNG pixel used as a placeholder for errored backgrounds
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_PIXEL_BLOB = new Blob([Uint8Array.from(atob(PNG_PIXEL), c => c.charCodeAt(0))], { type: 'image/png' });
const PLACEHOLDER_IMAGE = `url('data:image/png;base64,${PNG_PIXEL}')`;

const THUMBNAIL_COLUMNS_MIN = 2;
const THUMBNAIL_COLUMNS_MAX = 8;
const THUMBNAIL_COLUMNS_MAX_MOBILE = 3;
const THUMBNAIL_COLUMNS_DEFAULT_DESKTOP = 5;
const THUMBNAIL_COLUMNS_DEFAULT_MOBILE = 3;
const THUMBNAIL_COLUMNS_MOBILE_QUERY = '(max-width: 768px)';

/**
 * Storage for frontend-generated background thumbnails.
 * This is used to store thumbnails for backgrounds that cannot be generated on the server.
 */
const THUMBNAIL_STORAGE = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });

/**
 * Cache for thumbnail blob URLs.
 * @type {Map<string, string>}
 */
const THUMBNAIL_BLOBS = new Map();
// SillyBunny: bound active thumbnail blob URLs and revoke evicted entries so gallery browsing does not leak memory.
const MAX_THUMBNAIL_BLOB_URLS = 64;

function cacheThumbnailBlobUrl(bg, blobUrl) {
    const existing = THUMBNAIL_BLOBS.get(bg);
    if (existing && existing !== blobUrl) {
        URL.revokeObjectURL(existing);
    }
    THUMBNAIL_BLOBS.delete(bg);
    THUMBNAIL_BLOBS.set(bg, blobUrl);

    if (THUMBNAIL_BLOBS.size <= MAX_THUMBNAIL_BLOB_URLS) {
        return;
    }

    const activeName = background_settings?.name;
    for (const [evictKey, evictUrl] of THUMBNAIL_BLOBS) {
        if (THUMBNAIL_BLOBS.size <= MAX_THUMBNAIL_BLOB_URLS) {
            break;
        }
        if (evictKey === bg || evictKey === activeName) {
            continue;
        }
        THUMBNAIL_BLOBS.delete(evictKey);
        URL.revokeObjectURL(evictUrl);
        // Re-arm lazy loading if the evicted tile is still in the DOM so scrolling back restores it from IndexedDB.
        if (typeof document !== 'undefined') {
            const tile = document.querySelector(`.bg_example[bgfile="${CSS.escape(evictKey)}"] .bg_example_clipper`);
            if (tile instanceof HTMLElement && tile.style.backgroundImage.includes(evictUrl)) {
                tile.style.backgroundImage = '';
                tile.classList.add('lazy-load-background');
                lazyLoadObserver?.observe(tile);
            }
        }
    }
}

const THUMBNAIL_CONFIG = {
    width: 160,
    height: 90,
};

const ANIMATED_BACKGROUND_EXTENSIONS = ['mp4', 'webm', 'ogv', 'm4v', 'webp', 'gif', 'apng'];
const NATIVE_VIDEO_BACKGROUND_EXTENSIONS = ['mp4', 'webm', 'ogv', 'm4v'];

/**
 * Cache for image metadata.
 * @type {Map<string, import('../../src/endpoints/image-metadata.js').ImageMetadata>}
 */
const METADATA_CACHE = new Map();

/**
 * Background source types.
 * @readonly
 * @enum {number}
 */
const BG_SOURCES = {
    GLOBAL: 0,
    CHAT: 1,
};

/**
 * Background sorting options.
 * @readonly
 * @enum {string}
 */
const BG_SORT_OPTIONS = {
    AZ: 'az',
    ZA: 'za',
    NEWEST: 'newest',
    OLDEST: 'oldest',
};

/**
 * Mapping of background sources to their corresponding tab IDs.
 * @readonly
 * @type {Record<string, string>}
 */
const BG_TABS = Object.freeze({
    [BG_SOURCES.GLOBAL]: 'bg_global_tab',
    [BG_SOURCES.CHAT]: 'bg_chat_tab',
});

/**
 * Global IntersectionObserver instance for lazy loading backgrounds
 * @type {IntersectionObserver|null}
 */
let lazyLoadObserver = null;

/**
 * Cache for the current list of system background filenames.
 * Used to re-sort backgrounds without refetching from the server.
 * @type {Array<{filename: string, isAnimated: boolean}>}
 */
let cachedSystemBackgrounds = [];

export let background_settings = {
    name: '__transparent.png',
    url: generateUrlParameter('__transparent.png', false),
    fitting: 'classic',
    animation: false,
    sortOrder: BG_SORT_OPTIONS.AZ,
};

/**
 * Sorts an array of background filenames based on the current sort order.
 * @param {string[]} backgrounds - Array of background filenames
 * @param {boolean} isCustom - Whether these are custom (chat) backgrounds
 * @returns {string[]} Sorted array of background filenames
 */
function sortBackgrounds(backgrounds, isCustom = false) {
    const sortOrder = background_settings.sortOrder || BG_SORT_OPTIONS.AZ;

    return [...backgrounds].sort((a, b) => {
        switch (sortOrder) {
            case BG_SORT_OPTIONS.AZ:
                return sortIgnoreCaseAndAccents(a, b);
            case BG_SORT_OPTIONS.ZA:
                return sortIgnoreCaseAndAccents(b, a);
            case BG_SORT_OPTIONS.NEWEST:
            case BG_SORT_OPTIONS.OLDEST: {
                const keyA = isCustom ? a : `backgrounds/${a}`;
                const keyB = isCustom ? b : `backgrounds/${b}`;
                const metaA = METADATA_CACHE.get(keyA);
                const metaB = METADATA_CACHE.get(keyB);
                const timestampA = metaA?.addedTimestamp ?? 0;
                const timestampB = metaB?.addedTimestamp ?? 0;
                // Newest first (descending) or oldest first (ascending)
                return sortOrder === BG_SORT_OPTIONS.NEWEST
                    ? timestampB - timestampA
                    : timestampA - timestampB;
            }
            default:
                return 0;
        }
    });
}

/**
 * Creates a single thumbnail DOM element. The CSS now handles all sizing.
 * @param {object} imageData - Data for the image (filename, isCustom, isAnimated).
 * @returns {HTMLElement} The created thumbnail element.
 */
function createThumbnailElement(imageData) {
    const bg = imageData.filename;
    const isCustom = imageData.isCustom;
    const isAnimated = imageData.isAnimated ?? false;
    const mediaType = imageData.mediaType ?? (isVideoBackgroundExtension(bg) ? 'video' : 'image');

    const thumbnail = $('#background_template .bg_example').clone();

    const clipper = document.createElement('div');
    clipper.className = 'thumbnail-clipper lazy-load-background';
    clipper.style.backgroundImage = PLACEHOLDER_IMAGE;

    // Apply dominant color and aspect ratio as placeholder if available
    const metadataKey = isCustom ? bg : `backgrounds/${bg}`;
    const metadata = METADATA_CACHE.get(metadataKey);
    if (metadata) {
        if (metadata.dominantColor) {
            clipper.style.backgroundColor = metadata.dominantColor;
        }
        if (metadata.aspectRatio) {
            thumbnail.css('aspect-ratio', metadata.aspectRatio);
        }
    }

    // SillyBunny: a thumbnail in the folder gallery has its own menu, so the hover strip and its toggle are not built.
    if (imageData.withMenu === false) thumbnail.find('.jg-menu, .mobile-only-menu-toggle').remove();

    const titleElement = thumbnail.find('.BGSampleTitle');
    clipper.appendChild(titleElement.get(0));
    thumbnail.append(clipper);

    const url = generateUrlParameter(bg, isCustom);
    const title = isCustom ? bg.split('/').pop() : bg;
    const friendlyTitle = getFriendlyBackgroundTitle(title);

    thumbnail.attr('title', title);
    thumbnail.attr('bgfile', bg);
    thumbnail.attr('custom', String(isCustom));
    thumbnail.attr('animated', String(isAnimated));
    thumbnail.attr('data-media-type', mediaType);
    thumbnail.data('url', url);
    titleElement.text(friendlyTitle);

    return thumbnail.get(0);
}

// SillyBunny: shared by the thumbnail and by Auto-select, which no longer reads titles from the DOM.
/** The name a thumbnail shows: the file name without its extension. */
function getFriendlyBackgroundTitle(title) {
    return String(title || '').slice(0, title.lastIndexOf('.'));
}

function getMobileThumbnailColumnsQuery() {
    return window.matchMedia?.(THUMBNAIL_COLUMNS_MOBILE_QUERY);
}

function getMaxThumbnailColumnsForViewport() {
    return getMobileThumbnailColumnsQuery()?.matches ? THUMBNAIL_COLUMNS_MAX_MOBILE : THUMBNAIL_COLUMNS_MAX;
}

function clampThumbnailColumns(count, maxColumns = THUMBNAIL_COLUMNS_MAX) {
    return Math.max(THUMBNAIL_COLUMNS_MIN, Math.min(count, maxColumns));
}

function getEffectiveThumbnailColumns() {
    return clampThumbnailColumns(background_settings.thumbnailColumns, getMaxThumbnailColumnsForViewport());
}

/**
 * Updates the rendered thumbnail column count without overwriting the saved desktop preference.
 */
function updateThumbnailColumnsControls() {
    const effectiveCount = getEffectiveThumbnailColumns();
    document.documentElement.style.setProperty('--bg-thumb-columns', effectiveCount.toString());

    $('#bg_thumb_zoom_in').prop('disabled', effectiveCount <= THUMBNAIL_COLUMNS_MIN);
    $('#bg_thumb_zoom_out').prop('disabled', effectiveCount >= getMaxThumbnailColumnsForViewport());
}

/**
 * Applies the saved thumbnail column preference to the current viewport.
 * @param {number} count - The preferred number of columns.
 */
function applyThumbnailColumns(count) {
    background_settings.thumbnailColumns = clampThumbnailColumns(count);
    updateThumbnailColumnsControls();

    saveSettingsDebounced();
}

export function loadBackgroundSettings(settings) {
    let backgroundSettings = settings.background;
    if (!backgroundSettings || !backgroundSettings.name || !backgroundSettings.url) {
        backgroundSettings = background_settings;
    }
    if (!backgroundSettings.fitting) {
        backgroundSettings.fitting = 'classic';
    }
    if (!Object.hasOwn(backgroundSettings, 'animation')) {
        backgroundSettings.animation = false;
    }
    if (!backgroundSettings.sortOrder) {
        backgroundSettings.sortOrder = BG_SORT_OPTIONS.AZ;
    }

    // If a value is already saved, use it. Otherwise, determine default based on screen size.
    let columns = backgroundSettings.thumbnailColumns;
    if (!columns) {
        const isNarrowScreen = getMobileThumbnailColumnsQuery()?.matches;
        columns = isNarrowScreen ? THUMBNAIL_COLUMNS_DEFAULT_MOBILE : THUMBNAIL_COLUMNS_DEFAULT_DESKTOP;
    }
    background_settings.thumbnailColumns = columns;
    background_settings.sortOrder = backgroundSettings.sortOrder;
    background_settings.animation = backgroundSettings.animation;
    applyThumbnailColumns(background_settings.thumbnailColumns);

    setBackground(backgroundSettings.name, backgroundSettings.url);
    setFittingClass(backgroundSettings.fitting);
    $('#background_fitting').val(backgroundSettings.fitting);
    $('#background_thumbnails_animation').prop('checked', background_settings.animation);
    $('#bg-sort').val(background_settings.sortOrder);
    highlightSelectedBackground();
}

/**
 * Sets the background for the current chat and adds it to the list of custom backgrounds.
 * @param {{url: string, path:string}} backgroundInfo
 */
async function forceSetBackground(backgroundInfo) {
    saveBackgroundMetadata(backgroundInfo.url);
    $('#bg1').css('background-image', backgroundInfo.url);

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const bg = backgroundInfo.path;
    list.push(bg);
    chat_metadata[LIST_METADATA_KEY] = list;
    saveMetadataDebounced();
    renderChatBackgrounds();
    highlightNewBackground(bg);
    highlightLockedBackground();
}

async function onChatChanged() {
    const lockedUrl = chat_metadata[BG_METADATA_KEY];

    $('#bg1').css('background-image', lockedUrl || background_settings.url);

    renderChatBackgrounds();
    highlightLockedBackground();
    highlightSelectedBackground();
}

/**
 * Checks if a given URL corresponds to a custom background in the current chat's metadata.
 * @param {string} fileUrl - The URL to check against the chat's custom backgrounds.
 * @returns {boolean} True if the URL corresponds to a custom background, false otherwise.
 */
export function isCustomBackgroundUrl(fileUrl) {
    const customBackgrounds = chat_metadata[LIST_METADATA_KEY] || [];
    return customBackgrounds.some(bg => bg === fileUrl || generateUrlParameter(bg, true) === fileUrl);
}

/**
 * Gets the client path for a background image, encoding the file name for safe URL usage.
 * @param {string} fileUrl File name or URL of the background image
 * @returns {string} Client path for the system backgroun
 */
export function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

function highlightLockedBackground() {
    $('.bg_example.locked-background').removeClass('locked-background');

    const lockedBackgroundUrl = chat_metadata[BG_METADATA_KEY];

    if (lockedBackgroundUrl) {
        $('.bg_example').filter(function () {
            return $(this).data('url') === lockedBackgroundUrl;
        }).addClass('locked-background');
    }
}

/**
 * Locks the background for the current chat
 * @param {Event|null} event
 */
function onLockBackgroundClick(event = null) {
    if (!getCurrentChatId()) {
        toastr.warning(t`Select a chat to lock the background for it`);
        return;
    }

    // Take the global background's URL and save it to the chat's metadata.
    lockBackgroundUrl(event ? $(event.target).closest('.bg_example').data('url') : background_settings.url);
}

// SillyBunny: split out of onLockBackgroundClick, so a thumbnail menu can lock a background by file name.
/**
 * Locks a background URL to the current chat and shows it.
 * @param {string} urlToLock
 */
function lockBackgroundUrl(urlToLock) {
    saveBackgroundMetadata(urlToLock);
    $('#bg1').css('background-image', urlToLock);

    // Update UI states to reflect the new lock.
    highlightLockedBackground();
    highlightSelectedBackground();
}

/**
 * Unlocks the background for the current chat
 * @param {Event|null} _event
 */
function onUnlockBackgroundClick(_event = null) {
    // Delete the lock from the chat's metadata.
    removeBackgroundMetadata();

    // Revert the view to the current global background.
    $('#bg1').css('background-image', background_settings.url);

    // Update UI states to reflect the removal of the lock.
    highlightLockedBackground();
    highlightSelectedBackground();
}

function isChatBackgroundLocked() {
    return chat_metadata[BG_METADATA_KEY];
}

function saveBackgroundMetadata(file) {
    chat_metadata[BG_METADATA_KEY] = file;
    saveMetadataDebounced();
}

function removeBackgroundMetadata() {
    delete chat_metadata[BG_METADATA_KEY];
    saveMetadataDebounced();
}

/**
 * Handles the click event for selecting a background.
 * @param {JQuery.Event} e Event
 */
function onSelectBackgroundClick(e) {
    const bgFile = $(this).attr('bgfile');
    const isCustom = $(this).attr('custom') === 'true';
    applyBackgroundChoice({ bgFile, isCustom, backgroundCssUrl: getUrlParameter(this), bypassGlobalLock: !isCustom && e.shiftKey });
}

// SillyBunny: split out of onSelectBackgroundClick, so the folder gallery and the commands can choose a background that has no thumbnail built.
/**
 * Makes a background the current one, as a click on its thumbnail does.
 * @param {object} choice
 * @param {string} choice.bgFile
 * @param {boolean} choice.isCustom
 * @param {string} choice.backgroundCssUrl
 * @param {boolean} [choice.bypassGlobalLock]
 */
function applyBackgroundChoice({ bgFile, isCustom, backgroundCssUrl, bypassGlobalLock = false }) {
    if ((isChatBackgroundLocked() || isCustom) && !bypassGlobalLock) {
        // If a background is locked, update the locked background directly
        saveBackgroundMetadata(backgroundCssUrl);
        $('#bg1').css('background-image', backgroundCssUrl);
    } else {
        // Otherwise, update the global background setting
        setBackground(bgFile, backgroundCssUrl);
    }

    // Update UI highlights to reflect the changes.
    highlightLockedBackground();
    highlightSelectedBackground();
}

async function onCopyToSystemBackgroundClick(e) {
    e.stopPropagation();
    const bgNames = await getNewBackgroundName(this);

    if (!bgNames) {
        return;
    }

    const bgFile = await fetch(bgNames.oldBg);

    if (!bgFile.ok) {
        toastr.warning('Failed to copy background');
        return;
    }

    const blob = await bgFile.blob();
    const file = new File([blob], bgNames.newBg);
    const formData = new FormData();
    formData.set('avatar', file);

    await uploadBackground(formData);

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const index = list.indexOf(bgNames.oldBg);
    list.splice(index, 1);
    saveMetadataDebounced();
    renderChatBackgrounds();
}

/**
 * Gets a thumbnail for the background from storage or fetches it if not available.
 * It caches the thumbnail in local storage and returns a blob URL for the thumbnail.
 * If the thumbnail cannot be fetched, it returns a transparent PNG pixel as a fallback.
 * @param {string} bg Background URL
 * @param {boolean} isCustom Is the background custom?
 * @returns {Promise<string>} Blob URL of the thumbnail
 */
async function getThumbnailFromStorage(bg, isCustom) {
    const cachedBlobUrl = THUMBNAIL_BLOBS.get(bg);
    if (cachedBlobUrl) {
        THUMBNAIL_BLOBS.delete(bg);
        THUMBNAIL_BLOBS.set(bg, cachedBlobUrl);
        return cachedBlobUrl;
    }

    const savedBlob = await THUMBNAIL_STORAGE.getItem(bg);
    if (savedBlob) {
        const savedBlobUrl = URL.createObjectURL(savedBlob);
        cacheThumbnailBlobUrl(bg, savedBlobUrl);
        return savedBlobUrl;
    }

    try {
        const url = isCustom ? bg : getBackgroundPath(bg);
        const response = await fetch(url, { cache: 'force-cache' });
        if (!response.ok) {
            throw new Error('Fetch failed with status: ' + response.status);
        }
        const imageBlob = await response.blob();
        const imageBase64 = await getBase64Async(imageBlob);
        const thumbnailBase64 = await createThumbnail(imageBase64, THUMBNAIL_CONFIG.width, THUMBNAIL_CONFIG.height);
        const thumbnailBlob = await fetch(thumbnailBase64).then(res => res.blob());
        await THUMBNAIL_STORAGE.setItem(bg, thumbnailBlob);
        const blobUrl = URL.createObjectURL(thumbnailBlob);
        cacheThumbnailBlobUrl(bg, blobUrl);
        return blobUrl;
    } catch (error) {
        console.error('Error fetching thumbnail, fallback image will be used:', error);
        const fallbackBlob = PNG_PIXEL_BLOB;
        const fallbackBlobUrl = URL.createObjectURL(fallbackBlob);
        cacheThumbnailBlobUrl(bg, fallbackBlobUrl);
        return fallbackBlobUrl;
    }
}

/**
 * Gets the new background name from the user.
 * @param {Element} referenceElement
 * @returns {Promise<{oldBg: string, newBg: string}>}
 * */
async function getNewBackgroundName(referenceElement) {
    const exampleBlock = $(referenceElement).closest('.bg_example');
    return promptNewBackgroundName(exampleBlock.attr('bgfile'), exampleBlock.attr('custom') === 'true');
}

// SillyBunny: split out of getNewBackgroundName, so the folder gallery can rename a background by its file name.
/**
 * Asks for a new name for a background.
 * @param {string|undefined} oldBg File name, or the stored path of a chat background.
 * @param {boolean} isCustom
 * @returns {Promise<{oldBg: string, newBg: string}|undefined>}
 */
async function promptNewBackgroundName(oldBg, isCustom) {
    if (!oldBg) {
        console.debug('no bgfile');
        return;
    }

    const fileExtension = oldBg.split('.').pop();
    const fileNameBase = isCustom ? oldBg.split('/').pop() : oldBg;
    const oldBgExtensionless = fileNameBase.replace(`.${fileExtension}`, '');
    const newBgExtensionless = await Popup.show.input(t`Enter new background name:`, null, oldBgExtensionless);

    if (!newBgExtensionless) {
        console.debug('no new_bg_extensionless');
        return;
    }

    const newBg = `${newBgExtensionless}.${fileExtension}`;

    if (oldBgExtensionless === newBgExtensionless) {
        console.debug('new_bg === old_bg');
        return;
    }

    return { oldBg, newBg };
}

async function onRenameBackgroundClick(e) {
    e.stopPropagation();

    await renameBackgroundFile(await getNewBackgroundName(this));
}

// SillyBunny: split out of onRenameBackgroundClick for the same reason.
/**
 * Renames a system background on the server and reloads the gallery.
 * @param {{oldBg: string, newBg: string}|undefined} bgNames
 */
async function renameBackgroundFile(bgNames) {
    if (!bgNames) {
        return;
    }

    const data = { old_bg: bgNames.oldBg, new_bg: bgNames.newBg };
    const response = await fetch('/api/backgrounds/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(data),
        cache: 'no-cache',
    });

    if (response.ok) {
        await getBackgrounds();
        highlightNewBackground(bgNames.newBg);
    } else {
        toastr.warning('Failed to rename background');
    }
}

async function onDeleteBackgroundClick(e) {
    e.stopPropagation();
    const bgToDelete = $(this).closest('.bg_example');
    const isCustom = bgToDelete.attr('custom') === 'true';
    const { confirm, deleteFromServer } = await confirmBackgroundDeletion(isCustom);
    const bg = bgToDelete.attr('bgfile');

    if (confirm && !await removeBackground(bg, { isCustom, deleteFromServer, element: bgToDelete })) {
        toastr.error(t`Background not deleted`);
    }
}

// SillyBunny: the delete confirmation and the delete itself are split out of onDeleteBackgroundClick, so a menu, a selection and the click handler share one path.
/**
 * Asks whether to delete a background.
 * @param {boolean} isCustom A chat background also offers to delete its file from the server.
 * @returns {Promise<{confirm: boolean, deleteFromServer: boolean}>}
 */
async function confirmBackgroundDeletion(isCustom) {
    const deleteFromServerId = 'delete_bg_from_server';
    /** @type {import('./popup.js').CustomPopupInput[]} */
    const customInputs = [{
        type: 'checkbox',
        label: t`Also delete file from server`,
        id: deleteFromServerId,
        defaultState: true,
    }];
    let deleteFromServer = false;
    // SillyBunny: background confirmations use an explicit destructive action.
    const confirm = await Popup.show.confirm(t`Delete the background?`, null, {
        okButton: t`Delete`,
        defaultResult: POPUP_RESULT.NEGATIVE,
        onOpening: popup => popup.okButton.classList.add('is-destructive'),
        customInputs: isCustom ? customInputs : [],
        onClose: (popup) => {
            if (isCustom) {
                deleteFromServer = Boolean(popup?.inputResults?.get(deleteFromServerId) ?? false);
            }
        },
    });
    return { confirm: Boolean(confirm), deleteFromServer };
}

/**
 * Removes one background: a system file from the server, or a chat background from the chat's list. A background that is
 * the current one, or the chat's lock, is replaced by a neighbour first, so the page never keeps a picture that is gone.
 * The caller has already asked the user.
 * @param {string} bg File name, or the stored path of a chat background.
 * @param {object} options
 * @param {boolean} options.isCustom
 * @param {boolean} [options.deleteFromServer] Also delete a chat background's file from the server.
 * @param {JQuery<HTMLElement>|null} [options.element] The background's thumbnail, when one is built.
 * @param {boolean} [options.redraw] Draw the gallery again afterwards; a caller that deletes many files draws once at the end.
 * @param {boolean} [options.replace] Pick a neighbour when this is the current background; a caller that deletes many files picks once, before the first.
 * @returns {Promise<boolean>} False when the server refused the deletion.
 */
async function removeBackground(bg, { isCustom, deleteFromServer = false, element = null, redraw = true, replace = true }) {
    const bgToDelete = element ?? $();
    const url = isCustom ? generateUrlParameter(bg, true) : generateUrlParameter(bg, false);
    // If it's not custom, it's a built-in background. Delete it from the server
    if (!isCustom) {
        if (!await delBackground(bg)) return false;
    } else {
        const list = chat_metadata[LIST_METADATA_KEY] || [];
        const index = list.indexOf(bg);
        list.splice(index, 1);
    }

    // Remove from cache to prevent reappearing on sort change
    const cachedIdx = cachedSystemBackgrounds.findIndex(img => img.filename === bg);
    if (!isCustom && cachedIdx !== -1) cachedSystemBackgrounds.splice(cachedIdx, 1);

    if (replace && (bg === background_settings.name || url === chat_metadata[BG_METADATA_KEY])) {
        const siblingSelector = '.bg_example';
        const nextBg = bgToDelete.next(siblingSelector);
        const prevBg = bgToDelete.prev(siblingSelector);

        if (nextBg.length > 0) {
            nextBg.trigger('click');
        } else if (prevBg.length > 0) {
            prevBg.trigger('click');
        } else {
            // SillyBunny: a system background is replaced by another system background, never by the hidden template or a chat thumbnail.
            const anyOtherBg = $(isCustom ? '.bg_example' : '#bg_menu_content .bg_example').not(bgToDelete).first();
            if (anyOtherBg.length > 0) {
                anyOtherBg.trigger('click');
            } else if (!isCustom && cachedSystemBackgrounds.length > 0) {
                // SillyBunny: a collapsed folder builds no thumbnails, so the replacement can come from the list the server gave.
                selectSystemBackground(cachedSystemBackgrounds[0].filename);
            }
        }
    }

    if (!isCustom) {
        // Clear the folder cover that referenced this image; the server keeps its own copy of the folders consistent.
        for (const folder of folderIndex.folders) {
            if (folder.thumbnailFile === bg) folder.thumbnailFile = '';
        }
        delete folderIndex.imageFolderMap[bg];
        galleryHost?.filesRemoved([bg]);
    }

    bgToDelete.remove();

    if (url === chat_metadata[BG_METADATA_KEY]) {
        removeBackgroundMetadata();
    }

    if (isCustom) {
        if (deleteFromServer) {
            await deleteMediaFromServer(bg);
        }
        renderChatBackgrounds();
        await saveMetadata();
    }

    highlightLockedBackground();
    highlightSelectedBackground();
    if (redraw) galleryHost?.render();
    return true;
}

/**
 * Deletes several system backgrounds, each through the path of a single delete. The caller has already asked the user.
 * @param {string[]} files
 * @returns {Promise<{deleted: string[], failed: string[]}>}
 */
async function removeSystemBackgrounds(files) {
    const deleted = [];
    const failed = [];
    // The current background, or the chat's lock, moves to a file that stays before any file goes, so it never lands on one that is about to be deleted.
    const doomed = new Set(files);
    const inUse = files.some(file => file === background_settings.name || generateUrlParameter(file, false) === chat_metadata[BG_METADATA_KEY]);
    const staying = cachedSystemBackgrounds.find(img => !doomed.has(img.filename));
    if (inUse && staying) selectSystemBackground(staying.filename);
    for (const file of files) {
        const element = $('#bg_menu_content .bg_example').filter(function () { return this.getAttribute('bgfile') === file; });
        let ok = false;
        try {
            ok = await removeBackground(file, { isCustom: false, element: element.length ? element.first() : null, redraw: false, replace: false });
        } catch (error) {
            console.error('Error deleting background:', file, error);
        }
        (ok ? deleted : failed).push(file);
    }
    galleryHost?.render();
    return { deleted, failed };
}

/** Makes a system background the current one, as a click on its thumbnail does. */
function selectSystemBackground(file, bypassGlobalLock = false) {
    applyBackgroundChoice({ bgFile: file, isCustom: false, backgroundCssUrl: generateUrlParameter(file, false), bypassGlobalLock });
}

const autoBgPrompt = 'Ignore previous instructions and choose a location ONLY from the provided list that is the most suitable for the current scene. Do not output any other text:\n{0}';

async function autoBackgroundCommand() {
    // SillyBunny: the choices come from the server's list, because a collapsed folder builds no thumbnails to read titles from.
    const options = cachedSystemBackgrounds
        .map(img => ({ element: { click: () => selectSystemBackground(img.filename) }, text: getFriendlyBackgroundTitle(img.filename).trim() }))
        .filter(x => x.text.length > 0);
    if (options.length == 0) {
        toastr.warning('No backgrounds to choose from. Please upload some images to the "backgrounds" folder.');
        return '';
    }

    const list = options.map(option => `- ${option.text}`).join('\n');
    const prompt = stringFormat(autoBgPrompt, list);
    const reply = await generateQuietPrompt({ quietPrompt: prompt });
    const fuse = new Fuse(options, { keys: ['text'] });
    const bestMatch = fuse.search(reply, { limit: 1 });

    if (bestMatch.length == 0) {
        for (const option of options) {
            if (String(reply).toLowerCase().includes(option.text.toLowerCase())) {
                console.debug('Fallback choosing background:', option);
                option.element.click();
                return '';
            }
        }

        toastr.warning('No match found. Please try again.');
        return '';
    }

    console.debug('Automatically choosing background:', bestMatch);
    bestMatch[0].item.element.click();
    return '';
}

/**
 * Renders the system backgrounds gallery.
 * @param {Array<{filename: string, isAnimated: boolean, mediaType?: string}>} [backgrounds] - Optional filtered list of backgrounds with metadata.
 */
function renderSystemBackgrounds(backgrounds) {
    // SillyBunny: once the gallery module has loaded, it draws the Global tab as folder sections.
    if (galleryHost) {
        galleryHost.render();
        return;
    }
    const sourceList = backgrounds || [];
    const container = $('#bg_menu_content');
    container.empty();

    if (sourceList.length === 0) {
        return;
    }

    const sortedList = sortBackgrounds(sourceList.map(bg => bg.filename), false);
    const metadataByFilename = new Map(sourceList.map(bg => [bg.filename, bg]));
    sortedList.forEach(filename => {
        const bg = metadataByFilename.get(filename);
        const imageData = {
            filename,
            isCustom: false,
            isAnimated: bg?.isAnimated ?? false,
            mediaType: bg?.mediaType ?? (isVideoBackgroundExtension(filename) ? 'video' : 'image'),
        };
        const thumbnail = createThumbnailElement(imageData);
        container.append(thumbnail);
    });

    activateLazyLoader();
}

// SillyBunny: the hint is the shared status page, built when the hint is first on screen. Building it at startup would load the
// status page stylesheet for a tab that most sessions never open.
function observeChatBackgroundsHint() {
    const hint = document.getElementById('bg_chat_hint');
    if (!hint || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(async entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        const { createStatusPage } = await import('./sillybunny-editor/status-page.js');
        // The upstream sentence, with its translation attributes, moves into the page's description.
        const sentence = [...hint.childNodes];
        const page = createStatusPage({ state: 'empty', icon: 'image', title: t`No Chat Backgrounds`, description: ' ', compact: true });
        page.element.querySelector('.sb-status-page__description').replaceChildren(...sentence);
        hint.replaceChildren(page.element);
    });
    observer.observe(hint);
}

/**
 * Renders the chat-specific (custom) backgrounds gallery.
 * @param {string[]} [backgrounds] - Optional filtered list of backgrounds.
 */
function renderChatBackgrounds(backgrounds) {
    const sourceList = backgrounds ?? (chat_metadata[LIST_METADATA_KEY] || []);
    const container = $('#bg_custom_content');
    container.empty();
    $('#bg_chat_hint').toggle(!sourceList.length);

    if (sourceList.length === 0) return;

    const sortedList = sortBackgrounds(sourceList, true);
    sortedList.forEach(bg => {
        // For custom backgrounds, infer isAnimated from extension since we don't have server metadata
        const isAnimated = isAnimatedBackgroundExtension(bg);
        const imageData = {
            filename: bg,
            isCustom: true,
            isAnimated,
            mediaType: isVideoBackgroundExtension(bg) ? 'video' : 'image',
        };
        const thumbnail = createThumbnailElement(imageData);
        container.append(thumbnail);
    });

    activateLazyLoader();
}

export async function getBackgrounds() {
    const response = await fetch('/api/backgrounds/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (response.ok) {
        const { images, config } = await response.json();
        Object.assign(THUMBNAIL_CONFIG, config);
        cachedSystemBackgrounds = images;

        // SillyBunny: folders load first, so the gallery module has the index when it draws the sections.
        await loadFolders();

        await preloadImageMetadata();

        renderSystemBackgrounds(cachedSystemBackgrounds);
        highlightSelectedBackground();
    }
}

/**
 * Preloads all image metadata to use dominant colors as placeholders.
 * @return {Promise<void>}
 */
async function preloadImageMetadata() {
    try {
        const response = await fetch('/api/image-metadata/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ prefix: 'backgrounds/' }),
        });
        if (response.ok) {
            const data = await response.json();
            if (data?.images) {
                METADATA_CACHE.clear();
                for (const [path, metadata] of Object.entries(data.images)) {
                    METADATA_CACHE.set(path, metadata);
                }
            }
        }
    } catch (error) {
        console.error('[ImageMetadata] Failed to preload metadata:', error);
    }
}

/**
 * Loads folder data from the server (separate from image loading).
 */
async function loadFolders() {
    try {
        const response = await fetch('/api/backgrounds/folders', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (response.ok) {
            const data = await response.json();
            const folderList = data.folders || [];
            const imageFolderMap = data.imageFolderMap || {};
            folderIndex = { folders: folderList, imageFolderMap };

            // Auto-assign thumbnail for folders that don't have one, then persist
            const allImages = cachedSystemBackgrounds.map(img => img.filename);
            /** @type {{id: string, thumbnailFile: string}[]} */
            const thumbnailUpdates = [];
            for (const folder of folderList) {
                if (!folder.thumbnailFile) {
                    const firstImage = allImages.find(img => {
                        const fids = imageFolderMap[img];
                        return fids && fids.includes(folder.id);
                    });
                    if (firstImage) {
                        folder.thumbnailFile = firstImage;
                        thumbnailUpdates.push({ id: folder.id, thumbnailFile: firstImage });
                    }
                }
            }
            if (thumbnailUpdates.length > 0) {
                await fetch('/api/image-metadata/folders/set-thumbnails', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ updates: thumbnailUpdates }),
                }).catch(err => console.debug('Auto-thumbnail save failed:', err));
            }

            galleryHost?.setIndex(folderIndex);
        }
    } catch (error) {
        console.error('Error loading folders:', error);
    }
}


function activateLazyLoader() {
    // Disconnect previous observer to prevent memory leaks
    if (lazyLoadObserver) {
        lazyLoadObserver.disconnect();
        lazyLoadObserver = null;
    }

    const lazyLoadElements = document.querySelectorAll('.lazy-load-background');

    const options = {
        root: null,
        rootMargin: '200px',
        threshold: 0.01,
    };

    lazyLoadObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.target instanceof HTMLElement && entry.isIntersecting) {
                const clipper = entry.target;
                const parentThumbnail = clipper.closest('.bg_example');

                if (parentThumbnail) {
                    const bg = parentThumbnail.getAttribute('bgfile');
                    const isCustom = parentThumbnail.getAttribute('custom') === 'true';
                    const isAnimated = parentThumbnail.getAttribute('animated') === 'true';
                    resolveImageUrl(bg, isCustom, isAnimated)
                        .then(url => { clipper.style.backgroundImage = url; })
                        .catch(() => { clipper.style.backgroundImage = PLACEHOLDER_IMAGE; });
                }

                clipper.classList.remove('lazy-load-background');
                observer.unobserve(clipper);
            }
        });
    }, options);

    lazyLoadElements.forEach(element => {
        lazyLoadObserver.observe(element);
    });
}

/**
 * Gets the CSS URL of the background
 * @param {Element} block
 * @returns {string} URL of the background
 */
function getUrlParameter(block) {
    return $(block).closest('.bg_example').data('url');
}

function generateUrlParameter(bg, isCustom) {
    return isCustom ? `url("${encodeURI(bg)}")` : `url("${getBackgroundPath(bg)}")`;
}

function isAnimatedBackgroundExtension(fileName) {
    const fileExtension = getBackgroundFileExtension(fileName);
    return ANIMATED_BACKGROUND_EXTENSIONS.includes(fileExtension);
}

function getBackgroundFileExtension(fileName) {
    if (!fileName) {
        return '';
    }

    const normalized = String(fileName).split('?')[0].split('#')[0];

    try {
        const pathname = new URL(normalized, window.location.origin).pathname;
        return pathname.split('.').pop()?.toLowerCase() ?? '';
    } catch {
        return normalized.split('.').pop()?.toLowerCase() ?? '';
    }
}

function isVideoBackgroundExtension(fileName) {
    const fileExtension = getBackgroundFileExtension(fileName);
    return NATIVE_VIDEO_BACKGROUND_EXTENSIONS.includes(fileExtension);
}

/**
 * Resolves the image URL for the background.
 * @param {string} bg Background file name
 * @param {boolean} isCustom Is a custom background
 * @param {boolean|null} [isAnimated=null] Is the background animated (from metadata). If null, infers from extension.
 * @returns {Promise<string>} CSS URL of the background
 */
async function resolveImageUrl(bg, isCustom, isAnimated = null) {
    if (isVideoBackgroundExtension(bg)) {
        return PLACEHOLDER_IMAGE;
    }

    // If isAnimated is not provided (null), fall back to extension-based heuristic
    let animated = isAnimated;
    if (animated === null) {
        animated = isAnimatedBackgroundExtension(bg);
    }

    const thumbnailUrl = animated && !background_settings.animation
        ? await getThumbnailFromStorage(bg, isCustom)
        : isCustom
            ? bg
            : getThumbnailUrl('bg', bg);

    return `url("${thumbnailUrl}")`;
}

async function setBackground(bg, url) {
    // Only change the visual background if one is not locked for the current chat.
    if (!isChatBackgroundLocked()) {
        $('#bg1').css('background-image', url);
    }
    background_settings.name = bg;
    background_settings.url = url;
    saveSettingsDebounced();
}

async function delBackground(bg) {
    const response = await fetch('/api/backgrounds/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            bg: bg,
        }),
    });
    // SillyBunny: a refused deletion keeps the background in the gallery and is reported by the caller.
    if (!response.ok) return false;

    await THUMBNAIL_STORAGE.removeItem(bg);
    if (THUMBNAIL_BLOBS.has(bg)) {
        URL.revokeObjectURL(THUMBNAIL_BLOBS.get(bg));
        THUMBNAIL_BLOBS.delete(bg);
    }
    return true;
}

/**
 * Background upload handler.
 * @param {Event} e Event
 * @returns {Promise<void>}
 */
async function onBackgroundUploadSelected(e) {
    const input = e.currentTarget;

    if (!(input instanceof HTMLInputElement)) {
        console.error('Invalid input element for background upload');
        return;
    }

    for (const file of input.files) {
        if (file.size === 0) {
            continue;
        }

        const formData = new FormData();
        formData.append('avatar', file);

        await convertFileIfVideo(formData);
        switch (getActiveBackgroundTab()) {
            case BG_SOURCES.GLOBAL:
                await uploadBackground(formData);
                break;
            case BG_SOURCES.CHAT:
                await uploadChatBackground(formData);
                break;
            default:
                console.error('Unknown background source type');
                continue;
        }
    }

    // Allow re-uploading the same file again by clearing the input value
    input.value = '';
}

/**
 * Converts a video file to an animated webp format if the file is a video.
 * @param {FormData} formData
 * @returns {Promise<void>}
 */
async function convertFileIfVideo(formData) {
    const file = formData.get('avatar');
    if (!(file instanceof File)) {
        return;
    }
    if (!file.type.startsWith('video/')) {
        return;
    }
    if (isVideoBackgroundExtension(file.name)) {
        return;
    }
    if (typeof globalThis.convertVideoToAnimatedWebp !== 'function') {
        toastr.info(t`Native video backgrounds work best with MP4, WebM, OGV, or M4V files`); // SillyBunny: no trailing period, by DESIGN.md
        return;
    }

    let toastMessage = jQuery();
    try {
        toastMessage = toastr.info(t`Preparing video for upload. This may take several minutes.`, t`Please wait`, { timeOut: 0, extendedTimeOut: 0 });
        const sourceBuffer = await file.arrayBuffer();
        const convertedBuffer = await globalThis.convertVideoToAnimatedWebp({ buffer: new Uint8Array(sourceBuffer), name: file.name });
        const convertedFileName = file.name.replace(/\.[^/.]+$/, '.webp');
        const convertedFile = new File([new Uint8Array(convertedBuffer)], convertedFileName, { type: 'image/webp' });
        formData.set('avatar', convertedFile);
        toastMessage.remove();
    } catch (error) {
        formData.delete('avatar');
        toastMessage.remove();
        console.error('Error converting video to animated webp:', error);
        toastr.error(t`Error converting video to animated webp`);
    }
}

/**
 * Uploads a background to the server
 * @param {FormData} formData
 */
async function uploadBackground(formData) {
    try {
        if (!formData.has('avatar')) {
            console.log('No file provided. Background upload cancelled.');
            return;
        }

        const response = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error('Failed to upload background');
        }

        const bg = await response.text();
        setBackground(bg, generateUrlParameter(bg, false));
        await getBackgrounds();
        highlightNewBackground(bg);
    } catch (error) {
        console.error('Error uploading background:', error);
    }
}

/**
 * Upload a chat background using a FormData object.
 * @param {FormData} formData FormData containing the background file
 * @returns {Promise<void>}
 */
async function uploadChatBackground(formData) {
    try {
        if (!getCurrentChatId()) {
            toastr.warning(t`Select a chat to upload a background for it`);
            return;
        }
        if (!formData.has('avatar')) {
            console.log('No file provided. Chat background upload cancelled.');
            return;
        }

        const file = formData.get('avatar');
        if (!(file instanceof File)) {
            console.error('Invalid file type for chat background upload');
            return;
        }

        const imageDataUri = await getBase64Async(file);
        const base64Data = imageDataUri.split(',')[1];
        const extension = getFileExtension(file);
        const characterName = selected_group
            ? groups.find(g => g.id === selected_group)?.id?.toString()
            : characters[this_chid]?.name;
        const filename = `${characterName}_${humanizedDateTime()}`;
        const imagePath = await saveBase64AsFile(base64Data, characterName, filename, extension);

        const list = chat_metadata[LIST_METADATA_KEY] || [];
        list.push(imagePath);
        chat_metadata[LIST_METADATA_KEY] = list;
        await saveMetadata();
        renderChatBackgrounds();
        highlightNewBackground(imagePath);
        highlightLockedBackground();
        highlightSelectedBackground();
    } catch (error) {
        console.error('Error uploading chat background:', error);
    }
}

/**
 * @param {string} bg
 */
function highlightNewBackground(bg) {
    const newBg = $(`.bg_example[bgfile="${bg}"]`);
    // SillyBunny: a file in a collapsed folder has no thumbnail to show.
    if (!newBg.length) return;
    const scrollOffset = newBg.offset().top - newBg.parent().offset().top;
    $('#Backgrounds').scrollTop(scrollOffset);
    flashHighlight(newBg);
}

/**
 * Sets the fitting class for the background element
 * @param {string} fitting Fitting type
 */
function setFittingClass(fitting) {
    const backgrounds = $('#bg1');
    for (const option of ['cover', 'contain', 'stretch', 'center']) {
        backgrounds.toggleClass(option, option === fitting);
    }
    background_settings.fitting = fitting;
}

function highlightSelectedBackground() {
    $('.bg_example.selected-background').removeClass('selected-background');

    // The "selected" highlight should always reflect the global background setting.
    const activeUrl = background_settings.url;

    if (activeUrl) {
        // Find the thumbnail whose data-url attribute matches the active URL
        $('.bg_example').filter(function () {
            return $(this).data('url') === activeUrl;
        }).addClass('selected-background');
    }
}

function onBackgroundFilterInput() {
    const filterValue = String($('#bg-filter').val()).toLowerCase();
    // SillyBunny: the gallery module filters the Global tab itself, because it draws sections and not a flat list.
    const filtered = galleryHost ? '#bg_custom_content > .bg_example' : '#bg_menu_content > .bg_example, #bg_custom_content > .bg_example';
    $(filtered).each(function () {
        const $bg = $(this);
        const title = $bg.attr('title') || '';
        const hasMatch = title.toLowerCase().includes(filterValue);
        $bg.toggle(hasMatch);
    });
    galleryHost?.setQuery(filterValue);
}

const debouncedOnBackgroundFilterInput = debounce(onBackgroundFilterInput, debounce_timeout.standard);

/**
 * Gets the active background tab source.
 * @returns {BG_SOURCES} Active background tab source
 */
export function getActiveBackgroundTab() {
    const tabs = $('#bg_tabs');
    if (!tabs.length || !tabs.data('ui-tabs')) {
        return BG_SOURCES.GLOBAL;
    }
    return tabs.tabs('option', 'active');
}

function setupBackgroundScrollToTop() {
    const drawer = document.getElementById('Backgrounds');
    const button = document.getElementById('bg-scroll-top');
    const panels = Object.values(BG_TABS).map(id => document.getElementById(id)).filter(panel => panel instanceof HTMLElement);
    if (!(drawer instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return;

    const getActivePanel = () => panels.find(panel => panel.getClientRects().length > 0);
    const updateVisibility = () => button.classList.toggle('visible', (getActivePanel()?.scrollTop ?? 0) > 300);
    for (const panel of panels) panel.addEventListener('scroll', updateVisibility, { passive: true });
    button.addEventListener('click', () => {
        getActivePanel()?.scrollTo({ top: 0, behavior: document.body.classList.contains('reduced-motion') ? 'auto' : 'smooth' });
    });
    $('#bg_tabs').on('tabsactivate', updateVisibility);
    new ResizeObserver(updateVisibility).observe(drawer);
    updateVisibility();
}

export function initBackgrounds() {
    observeChatBackgroundsHint();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);

    getMobileThumbnailColumnsQuery()?.addEventListener?.('change', updateThumbnailColumnsControls);

    $(document)
        .off('click', '.bg_example').on('click', '.bg_example', onSelectBackgroundClick)
        .off('click', '.bg_example .mobile-only-menu-toggle').on('click', '.bg_example .mobile-only-menu-toggle', function (e) {
            e.stopPropagation();
            const $context = $(this).closest('.bg_example');
            const wasOpen = $context.hasClass('mobile-menu-open');
            // Close all other open menus before opening a new one.
            $('.bg_example.mobile-menu-open').removeClass('mobile-menu-open');
            if (!wasOpen) {
                $context.addClass('mobile-menu-open');
            }
        })
        .off('blur', '.bg_example.mobile-menu-open').on('blur', '.bg_example.mobile-menu-open', function () {
            if (!$(this).is(':focus-within')) {
                $(this).removeClass('mobile-menu-open');
            }
        })
        .off('click', '.jg-button').on('click', '.jg-button', function (e) {
            e.stopPropagation();
            const action = $(this).data('action');

            switch (action) {
                case 'lock':
                    onLockBackgroundClick.call(this, e.originalEvent);
                    break;
                case 'unlock':
                    onUnlockBackgroundClick.call(this, e.originalEvent);
                    break;
                case 'edit':
                    onRenameBackgroundClick.call(this, e.originalEvent);
                    break;
                case 'delete':
                    onDeleteBackgroundClick.call(this, e.originalEvent);
                    break;
                case 'copy':
                    onCopyToSystemBackgroundClick.call(this, e.originalEvent);
                    break;
            }
        });

    $('#bg_thumb_zoom_in').on('click', () => {
        applyThumbnailColumns(getEffectiveThumbnailColumns() - 1);
    });
    $('#bg_thumb_zoom_out').on('click', () => {
        applyThumbnailColumns(getEffectiveThumbnailColumns() + 1);
    });
    $('#auto_background').on('click', autoBackgroundCommand);
    $('#add_bg_button').on('change', (e) => onBackgroundUploadSelected(e.originalEvent));
    $('#bg-filter').on('input', () => debouncedOnBackgroundFilterInput());
    $('#bg-sort').on('change', function () {
        background_settings.sortOrder = String($(this).val());
        saveSettingsDebounced();
        // Re-render both galleries with new sort order (respecting active folder filter)
        renderSystemBackgrounds(cachedSystemBackgrounds);
        renderChatBackgrounds();
        highlightSelectedBackground();
        highlightLockedBackground();
        // Re-apply any active search filter
        onBackgroundFilterInput();
    });
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lockbg',
        callback: () => {
            onLockBackgroundClick();
            return '';
        },
        aliases: ['bglock'],
        helpString: 'Locks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'unlockbg',
        callback: () => {
            onUnlockBackgroundClick();
            return '';
        },
        aliases: ['bgunlock'],
        helpString: 'Unlocks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'autobg',
        callback: autoBackgroundCommand,
        aliases: ['bgauto'],
        helpString: 'Automatically changes the background based on the chat context using the AI request prompt',
    }));

    $('#background_fitting').on('input', function () {
        background_settings.fitting = String($(this).val());
        setFittingClass(background_settings.fitting);
        saveSettingsDebounced();
    });

    $('#background_thumbnails_animation').on('input', async function () {
        background_settings.animation = !!$(this).prop('checked');
        saveSettingsDebounced();

        // Refresh background thumbnails
        await getBackgrounds();
        await onChatChanged();
    });

    // SillyBunny: <base href="/"> makes each tab link resolve to "/#id", so with a query string in the page URL jQuery UI treats the tab as remote and loads the whole app into a new panel. aria-controls binds each tab to its existing panel.
    for (const anchor of document.querySelectorAll('#bg_tabs .bg_tabs_list > li > a')) {
        anchor.parentElement.setAttribute('aria-controls', anchor.hash.slice(1));
    }
    // SillyBunny: with a query string jQuery UI still counts these tabs as remote and would fetch "/" on init and on every tab switch; history.replaceState can also add the query later.
    $('#bg_tabs').tabs({ beforeLoad: event => event.preventDefault() });
    // SillyBunny: jQuery UI marks panels of "remote" tabs as live regions, which would announce every thumbnail change.
    $('#bg_tabs > .ui-tabs-panel').removeAttr('aria-live');
    // SillyBunny: one toolbar button follows the active source instead of competing tab observers.
    setupBackgroundScrollToTop();
    document.getElementById('Backgrounds')?.addEventListener('keydown', event => {
        // Upstream's global Enter handler also clicks native buttons, doubling their activation.
        if (event.key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('button')) event.stopPropagation();
    });
}

// SillyBunny: used by /bg and its enum, which read the DOM for thumbnails before folders could leave some unbuilt.
/**
 * Every background a command can pick, whether or not its thumbnail is built: a collapsed folder in the gallery builds none.
 * @returns {Array<{bgfile: string, select: () => void}>}
 */
export function getBackgroundTargets() {
    const built = Array.from(document.querySelectorAll('.bg_example'), element => ({ bgfile: element.getAttribute('bgfile') ?? '', select: () => element.click() }));
    const builtSystem = new Set(Array.from(document.querySelectorAll('#bg_menu_content .bg_example'), element => element.getAttribute('bgfile')));
    const unbuilt = cachedSystemBackgrounds
        .filter(img => !builtSystem.has(img.filename))
        .map(img => ({ bgfile: img.filename, select: () => selectSystemBackground(img.filename) }));
    return [...built, ...unbuilt];
}

// SillyBunny: the folder gallery (sillybunny-background-gallery.js) reads and drives the Global tab through this object.
/**
 * The folder gallery's way into this file. It reads what the gallery shows through these and takes over the Global tab by
 * attaching a host; nothing else in the app calls it.
 * @param {{render: () => void, setQuery: (value: string) => void, setIndex: (index: object) => void, filesRemoved: (files: string[]) => void}} host
 */
export function attachBackgroundGallery(host) {
    galleryHost = host;
    return {
        getImages: () => cachedSystemBackgrounds,
        getFolderIndex: () => folderIndex,
        sortFiles: files => sortBackgrounds(files, false),
        createThumbnail: imageData => createThumbnailElement({ ...imageData, isCustom: false, withMenu: false }),
        activateLazyLoader,
        refreshHighlights: () => {
            highlightSelectedBackground();
            highlightLockedBackground();
        },
        isVideo: isVideoBackgroundExtension,
        getThumbnailUrl: file => getThumbnailUrl('bg', file),
        getActiveTab: getActiveBackgroundTab,
        getTabs: () => BG_SOURCES,
        selectBackground: selectSystemBackground,
        isLocked: file => Boolean(chat_metadata[BG_METADATA_KEY]) && chat_metadata[BG_METADATA_KEY] === generateUrlParameter(file, false),
        lockBackground: file => {
            if (!getCurrentChatId()) {
                toastr.warning(t`Select a chat to lock the background for it`);
                return;
            }
            lockBackgroundUrl(generateUrlParameter(file, false));
        },
        unlockBackground: () => onUnlockBackgroundClick(),
        renameBackground: async file => renameBackgroundFile(await promptNewBackgroundName(file, false)),
        deleteBackgroundWithConfirmation: async file => {
            const { confirm } = await confirmBackgroundDeletion(false);
            if (!confirm) return;
            const element = $('#bg_menu_content .bg_example').filter(function () { return this.getAttribute('bgfile') === file; }).first();
            if (!await removeBackground(file, { isCustom: false, element })) toastr.error(t`Background not deleted`);
        },
        deleteBackgrounds: removeSystemBackgrounds,
        reload: getBackgrounds,
        getRequestHeaders,
    };
}
