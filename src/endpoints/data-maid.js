import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import express from 'express';
import mime from 'mime-types';
import { getSettingsBackupFilePrefix } from './settings.js';
import { CHAT_BACKUPS_PREFIX } from './chats.js';
import { isPathUnderParent, recoverFileWriteSync, tryParse } from '../util.js';
import { SETTINGS_FILE } from '../constants.js';
import { getKeptExternalMediaPaths } from '../external-media-manifest.js';
import { readConversationChatMessages } from '../conversation-media-references.js';
// SillyBunny: NovelAI Precise Reference PNGs stored as user files are listed in settings.json.
import { normalizeNovelAIPreciseReferencePath } from '../../public/scripts/novelai-precise-reference.js';
// SillyBunny: Conversation Mode stores messages, attachments, and group avatars under extension_settings.
import { CONVERSATION_STORE_KEY } from '../../public/scripts/sillybunny-conversation/constants.js';

const sha256 = str => crypto.createHash('sha256').update(str).digest('hex');

/**
 * Lists a directory that may not exist. A missing directory holds no references, so it counts as empty.
 * Any other failure is rethrown, because a reference that cannot be read would make the file that it names look loose.
 * @param {string} directory Directory to list
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
async function readDirectoryOrEmpty(directory) {
    try {
        return await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/**
 * Reads a text file that may not exist. A missing file holds no references, so it reads as `null`.
 * Any other failure is rethrown, for the same reason as in `readDirectoryOrEmpty`.
 * @param {string} filePath File to read
 * @returns {Promise<string | null>}
 */
async function readTextFileOrNull(filePath) {
    try {
        return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/**
 * SillyBunny: records NovelAI Precise Reference PNG paths saved in Image Generation or Quick Image Gen settings
 * so Data Maid keeps active references and still flags orphaned files.
 * @param {object} settings Parsed settings.json object
 * @param {Set<string>} knownFiles Set of referenced file paths relative to the user root
 */
function collectPreciseReferenceFiles(settings, knownFiles) {
    const addState = state => {
        if (!Array.isArray(state?.references)) return;
        for (const reference of state.references) {
            const normalized = normalizeNovelAIPreciseReferencePath(reference?.path);
            if (normalized) knownFiles.add(normalized.slice(1));
        }
    };
    addState(settings?.extension_settings?.sd?.novel_precise_reference);
    const qig = settings?.extension_settings?.['quick-image-gen'];
    if (!qig || typeof qig !== 'object') return;
    addState(qig.naiPreciseReference);
    addState(qig._charSettingsBaseState?.naiPreciseReference);
    if (Array.isArray(qig._backupConfigurations)) {
        for (const configuration of qig._backupConfigurations) {
            addState(configuration?.naiPreciseReference);
        }
    }
    if (qig._backupCharRefImages && typeof qig._backupCharRefImages === 'object') {
        for (const record of Object.values(qig._backupCharRefImages)) {
            addState(record?.naiPreciseReference);
        }
    }
}

/**
 * SillyBunny: normalizes a local user media/file URL stored in Conversation Mode so Data Maid keeps it intact.
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
function normalizeLocalAssetRef(rawUrl) {
    if (typeof rawUrl !== 'string') {
        return null;
    }
    const trimmed = rawUrl.trim();
    if (!trimmed || /^(?:https?:|data:|blob:)/i.test(trimmed)) {
        return null;
    }
    const withoutQuery = trimmed.split(/[?#]/, 1)[0];
    if (!withoutQuery) {
        return null;
    }
    try {
        return decodeURIComponent(withoutQuery).replace(/^\/+/, '');
    } catch {
        return withoutQuery.replace(/^\/+/, '');
    }
}

/**
 * SillyBunny: collects user image and file references stored inside Conversation Mode settings
 * so Data Maid never deletes active Conversation Mode attachments or group avatars as orphans.
 * @param {object} settings Parsed settings.json object
 * @param {Set<string>} knownImages Set of referenced image paths relative to the user root
 * @param {Set<string>} knownFiles Set of referenced file paths relative to the user root
 */
function collectConversationModeReferences(settings, knownImages, knownFiles) {
    const store = settings?.extension_settings?.[CONVERSATION_STORE_KEY];
    if (!store || typeof store !== 'object') {
        return;
    }

    const addRef = (rawUrl, targetSet) => {
        const normalized = normalizeLocalAssetRef(rawUrl);
        if (normalized) {
            targetSet.add(normalized);
        }
    };

    const recordMessage = (message) => {
        const extra = message?.extra;
        if (!extra || typeof extra !== 'object') {
            return;
        }
        addRef(extra.image_url, knownImages);
        addRef(extra.image, knownImages);
        addRef(extra.video, knownImages);
        if (Array.isArray(extra.image_swipes)) {
            for (const swipe of extra.image_swipes) {
                addRef(swipe, knownImages);
            }
        }
        if (Array.isArray(extra.media)) {
            for (const item of extra.media) {
                addRef(item?.url, knownImages);
            }
        }
        addRef(extra.file?.url, knownFiles);
        if (Array.isArray(extra.files)) {
            for (const item of extra.files) {
                addRef(item?.url, knownFiles);
            }
        }
        if (Array.isArray(extra.attachments)) {
            for (const item of extra.attachments) {
                const normalized = normalizeLocalAssetRef(item?.url);
                if (!normalized) {
                    continue;
                }
                const type = String(item?.type || '').toLowerCase();
                const mimeType = String(item?.mime || item?.mimeType || item?.contentType || '').toLowerCase();
                if (type === 'file' || (mimeType && !/^(?:image|audio|video)\//.test(mimeType)) || normalized.startsWith('user/files/')) {
                    knownFiles.add(normalized);
                } else {
                    knownImages.add(normalized);
                }
            }
        }
    };

    if (store.characters && typeof store.characters === 'object') {
        for (const threadStore of Object.values(store.characters)) {
            if (!threadStore || typeof threadStore !== 'object') {
                continue;
            }
            if (Array.isArray(threadStore.messages)) {
                for (const message of threadStore.messages) {
                    recordMessage(message);
                }
            }
            if (threadStore.branches && typeof threadStore.branches === 'object') {
                for (const branch of Object.values(threadStore.branches)) {
                    if (Array.isArray(branch?.messages)) {
                        for (const message of branch.messages) {
                            recordMessage(message);
                        }
                    }
                }
            }
        }
    }

    if (Array.isArray(store.groups)) {
        for (const group of store.groups) {
            addRef(group?.avatar_url, knownImages);
        }
    }
}

/**
 * @typedef {object} DataMaidRawReport
 * @property {string[]} images - List of loose user images
 * @property {string[]} files - List of loose user files
 * @property {string[]} chats - List of loose character chats
 * @property {string[]} groupChats - List of loose group chats
 * @property {string[]} avatarThumbnails - List of loose avatar thumbnails
 * @property {string[]} backgroundThumbnails - List of loose background thumbnails
 * @property {string[]} personaThumbnails - List of loose persona thumbnails
 * @property {string[]} chatBackups - List of chat backups
 * @property {string[]} settingsBackups - List of settings backups
 */

/**
 * @typedef {object} DataMaidSanitizedRecord - The entry excluding the sensitive paths.
 * @property {string} name - The name of the file.
 * @property {string} hash - The SHA-256 hash of the file path.
 * @property {string} [parent] - The name of the parent directory, if applicable.
 * @property {number} [size] - The size of the file in bytes, if available.
 * @property {number} [mtime] - The last modification time of the file, if available.
 */

/**
 * @typedef {object} DataMaidSanitizedReport - The report containing loose user data.
 * @property {DataMaidSanitizedRecord[]} images - List of sanitized loose user images
 * @property {DataMaidSanitizedRecord[]} files - List of sanitized loose user files
 * @property {DataMaidSanitizedRecord[]} chats - List of sanitized loose character chats
 * @property {DataMaidSanitizedRecord[]} groupChats - List of sanitized loose group chats
 * @property {DataMaidSanitizedRecord[]} avatarThumbnails - List of sanitized loose avatar thumbnails
 * @property {DataMaidSanitizedRecord[]} backgroundThumbnails - List of sanitized loose background thumbnails
 * @property {DataMaidSanitizedRecord[]} personaThumbnails - List of sanitized loose persona thumbnails
 * @property {DataMaidSanitizedRecord[]} chatBackups - List of sanitized chat backups
 * @property {DataMaidSanitizedRecord[]} settingsBackups - List of sanitized settings backups
 */

/**
 * @typedef {object} DataMaidMessage - The chat message object.
 * @property {DataMaidMessageExtra} [extra] - The extra data object.
 * @property {DataMaidChatMetadata} [chat_metadata] - The chat metadata object.
 */

/**
 * @typedef {object} DataMaidFile - The file object.
 * @property {string} url - The file URL
 */

/**
 * @typedef {object} DataMaidMedia - The media object.
 * @property {string} url - The media URL
 */

/**
 * @typedef {object} DataMaidChatMetadata - The chat metadata object.
 * @property {DataMaidFile[]} [attachments] - The array of attachments, if any.
 * @property {string[]} [chat_backgrounds] - The array of chat background image links, if any.
 */

/**
 * @typedef {object} DataMaidMessageExtra - The extra data object.
 * @property {string} [image] - The link to the image, if any - DEPRECATED, use `media` instead.
 * @property {string} [video] - The link to the video, if any - DEPRECATED, use `media` instead.
 * @property {string[]} [image_swipes] - The links to the image swipes, if any - DEPRECATED, use `media` instead.
 * @property {DataMaidMedia[]} [media] - The links to the media, if any.
 * @property {DataMaidFile} [file] - The file object, if any - DEPRECATED, use `files` instead.
 * @property {DataMaidFile[]} [files] - The array of file objects, if any.
 */

/**
 * @typedef {object} DataMaidTokenEntry
 * @property {string} handle - The user's handle or identifier.
 * @property {{path: string, hash: string}[]} paths - The list of file paths and their hashes that can be cleaned up.
 */

/**
 * Service for detecting and managing loose user data files.
 * Helps identify orphaned files that are no longer referenced by the application.
 */
export class DataMaidService {
    /**
     * @type {Map<string, DataMaidTokenEntry>} Map clean-up tokens to user IDs
     */
    static TOKENS = new Map();

    /**
     * Creates a new DataMaidService instance for a specific user.
     * @param {string} handle - The user's handle.
     * @param {import('../users.js').UserDirectoryList} directories - List of user directories to scan for loose data.
     */
    constructor(handle, directories) {
        this.handle = handle;
        this.directories = directories;
    }

    /**
     * Generates a report of loose user data.
     * @returns {Promise<DataMaidRawReport>} A report containing lists of loose user data.
     */
    async generateReport() {
        // SillyBunny: stream every .jsonl chat and settings.json once instead of parsing all chats four times serially.
        const [references, settings] = await Promise.all([
            this.#collectChatAndGroupReferences(),
            this.#readSettingsOnce(),
        ]);
        if (settings) {
            collectConversationModeReferences(settings, references.knownImages, references.knownFiles);
        }

        /** @type {DataMaidRawReport} */
        const report = {
            images: await this.#collectImages(references.knownImages),
            files: await this.#collectFiles(references.knownFiles, settings),
            chats: await this.#collectChats(),
            groupChats: await this.#collectGroupChats(),
            avatarThumbnails: await this.#collectAvatarThumbnails(),
            backgroundThumbnails: await this.#collectBackgroundThumbnails(),
            personaThumbnails: await this.#collectPersonaThumbnails(),
            chatBackups: await this.#collectChatBackups(),
            settingsBackups: await this.#collectSettingsBackups(),
        };

        return report;
    }

    /**
     * SillyBunny: reads and parses user settings.json once per report.
     * A settings file that cannot be read rejects, because the references in it would be missing from the report.
     * @returns {Promise<object | null>}
     */
    async #readSettingsOnce() {
        const settingsContent = await readTextFileOrNull(path.join(this.directories.root, SETTINGS_FILE));
        if (settingsContent === null) {
            return null;
        }
        const parsed = tryParse(settingsContent);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }

    /**
     * SillyBunny: single-pass streaming scan of all group definitions and .jsonl chat files
     * collecting both image and file references without retaining full chats in memory.
     * Rejects when any of them cannot be read, so the report never lists a referenced file as loose.
     * @returns {Promise<{ knownImages: Set<string>, knownFiles: Set<string> }>}
     */
    async #collectChatAndGroupReferences() {
        const knownImages = new Set();
        const knownFiles = new Set();

        const recordMetadata = (meta) => {
            if (!meta || typeof meta !== 'object') {
                return;
            }
            if (Array.isArray(meta.chat_backgrounds)) {
                for (const background of meta.chat_backgrounds) {
                    if (background) {
                        knownImages.add(background);
                    }
                }
            }
            if (Array.isArray(meta.attachments)) {
                for (const attachment of meta.attachments) {
                    if (attachment?.url) {
                        knownFiles.add(attachment.url);
                    }
                }
            }
        };

        const recordMessage = (message) => {
            const extra = message?.extra;
            if (!extra || typeof extra !== 'object') {
                return;
            }
            if (extra.image) {
                knownImages.add(extra.image);
            }
            if (extra.video) {
                knownImages.add(extra.video);
            }
            if (Array.isArray(extra.image_swipes)) {
                for (const swipe of extra.image_swipes) {
                    if (swipe) {
                        knownImages.add(swipe);
                    }
                }
            }
            if (Array.isArray(extra.media)) {
                for (const media of extra.media) {
                    if (media?.url) {
                        knownImages.add(media.url);
                    }
                }
            }
            if (extra.file?.url) {
                knownFiles.add(extra.file.url);
            }
            if (Array.isArray(extra.files)) {
                for (const file of extra.files) {
                    if (file?.url) {
                        knownFiles.add(file.url);
                    }
                }
            }
        };

        const scanJsonlFile = async (filePath) => {
            const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            let isFirstRecord = true;
            try {
                for await (const line of rl) {
                    if (!line) {
                        continue;
                    }
                    const record = tryParse(line);
                    if (!record || typeof record !== 'object') {
                        continue;
                    }
                    if (isFirstRecord) {
                        isFirstRecord = false;
                        if (record.chat_metadata) {
                            recordMetadata(record.chat_metadata);
                        }
                    }
                    recordMessage(record);
                }
            } catch (error) {
                // A chat file that vanished after it was listed names nothing any more.
                if (error?.code !== 'ENOENT') {
                    throw error;
                }
            }
        };

        for (const file of await readDirectoryOrEmpty(this.directories.groups)) {
            if (file.isFile() && path.parse(file.name).ext === '.json') {
                const fileContent = await readTextFileOrNull(path.join(this.directories.groups, file.name));
                const groupData = tryParse(fileContent ?? '');
                if (groupData?.chat_metadata) {
                    console.warn('Found group chat metadata in group definition - this is deprecated behavior.');
                    recordMetadata(groupData.chat_metadata);
                }
                if (groupData?.past_metadata && typeof groupData.past_metadata === 'object') {
                    console.warn('Found group past chat metadata in group definition - this is deprecated behavior.');
                    for (const pastMeta of Object.values(groupData.past_metadata)) {
                        recordMetadata(pastMeta);
                    }
                }
            }
        }

        for (const file of await readDirectoryOrEmpty(this.directories.groupChats)) {
            if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                await scanJsonlFile(path.join(this.directories.groupChats, file.name));
            }
        }

        for (const directory of await readDirectoryOrEmpty(this.directories.chats)) {
            if (directory.isDirectory()) {
                for (const file of await readDirectoryOrEmpty(path.join(this.directories.chats, directory.name))) {
                    if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                        await scanJsonlFile(path.join(this.directories.chats, directory.name, file.name));
                    }
                }
            }
        }

        // SillyBunny: conversation chats live in conversations/<id>/chats, which the two scans above do not read.
        for (const record of await readConversationChatMessages(this.directories, { strict: true })) {
            recordMessage(record);
        }

        return { knownImages, knownFiles };
    }


    /**
     * Sanitizes a record by hashing the file name and removing sensitive information.
     * Additionally, adds metadata like size and modification time.
     * @param {string} name The file or directory name to sanitize.
     * @param {boolean} withParent If the model should include the parent directory name.
     * @returns {Promise<DataMaidSanitizedRecord>} A sanitized record with the file name, hash, parent directory name, size, and modification time.
     */
    async #sanitizeRecord(name, withParent) {
        const stat = fs.existsSync(name) ? await fs.promises.stat(name) : null;
        return {
            name: path.basename(name),
            hash: sha256(name),
            parent: withParent ? path.basename(path.dirname(name)) : void 0,
            size: stat?.size,
            mtime: stat?.mtimeMs,
        };
    }

    /**
     * Sanitizes the report by hashing the file paths and removing sensitive information.
     * @param {DataMaidRawReport} report - The raw report containing loose user data.
     * @returns {Promise<DataMaidSanitizedReport>} A sanitized report with sensitive paths removed.
     */
    async sanitizeReport(report) {
        const sanitizedReport = {
            images: await Promise.all(report.images.map(i => this.#sanitizeRecord(i, true))),
            files: await Promise.all(report.files.map(i => this.#sanitizeRecord(i, false))),
            chats: await Promise.all(report.chats.map(i => this.#sanitizeRecord(i, true))),
            groupChats: await Promise.all(report.groupChats.map(i => this.#sanitizeRecord(i, false))),
            avatarThumbnails: await Promise.all(report.avatarThumbnails.map(i => this.#sanitizeRecord(i, false))),
            backgroundThumbnails: await Promise.all(report.backgroundThumbnails.map(i => this.#sanitizeRecord(i, false))),
            personaThumbnails: await Promise.all(report.personaThumbnails.map(i => this.#sanitizeRecord(i, false))),
            chatBackups: await Promise.all(report.chatBackups.map(i => this.#sanitizeRecord(i, false))),
            settingsBackups: await Promise.all(report.settingsBackups.map(i => this.#sanitizeRecord(i, false))),
        };

        return sanitizedReport;
    }

    /**
     * Collects loose user images from the provided directories.
     * Images are considered loose if they exist in the user images directory
     * but are not referenced in any chat messages.
     * @returns {Promise<string[]>} List of paths to loose user images
     */
    async #collectImages(knownImages) {
        const result = [];

        try {
            const knownImageFullPaths = new Set();
            knownImages.forEach(image => {
                if (typeof image !== 'string' || image.startsWith('http') || image.startsWith('data:')) {
                    return; // Skip URLs and data URIs
                }
                knownImageFullPaths.add(path.normalize(path.join(this.directories.root, image)));
            });
            // SillyBunny: a file that an external media import stored is named by card and lorebook text, which the chat scan above cannot see.
            const keptExternalMedia = await getKeptExternalMediaPaths(this.directories);
            const images = await fs.promises.readdir(this.directories.userImages, { withFileTypes: true });
            for (const dirent of images) {
                const direntPath = path.join(dirent.parentPath, dirent.name);
                if (dirent.isFile() && !knownImageFullPaths.has(direntPath)) {
                    result.push(direntPath);
                }
                if (dirent.isDirectory()) {
                    const subdirFiles = await fs.promises.readdir(direntPath, { withFileTypes: true });
                    for (const file of subdirFiles) {
                        const subdirFilePath = path.join(direntPath, file.name);
                        if (file.isFile() && !knownImageFullPaths.has(subdirFilePath) && !keptExternalMedia.has(subdirFilePath)) {
                            result.push(subdirFilePath);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting user images:', error);
        }

        return result;
    }

    /**
     * Collects loose user files from the provided directories.
     * Files are considered loose if they exist in the files directory
     * but are not referenced in chat messages, metadata, or settings.
     * @param {Set<string>} knownFiles
     * @param {object | null} settings
     * @returns {Promise<string[]>} List of paths to loose user files
     */
    async #collectFiles(knownFiles, settings) {
        const result = [];

        try {
            if (settings) {
                if (Array.isArray(settings?.extension_settings?.attachments)) {
                    for (const file of settings.extension_settings.attachments) {
                        if (file?.url) {
                            knownFiles.add(file.url);
                        }
                    }
                }
                if (typeof settings?.extension_settings?.character_attachments === 'object' && settings.extension_settings.character_attachments !== null) {
                    for (const files of Object.values(settings.extension_settings.character_attachments)) {
                        if (!Array.isArray(files)) {
                            continue;
                        }
                        for (const file of files) {
                            if (file?.url) {
                                knownFiles.add(file.url);
                            }
                        }
                    }
                }
                // SillyBunny: keep NovelAI Precise Reference PNGs referenced by Image Generation or Quick Image Gen.
                collectPreciseReferenceFiles(settings, knownFiles);
            }
            const knownFileFullPaths = new Set();
            knownFiles.forEach(file => {
                if (typeof file !== 'string' || file.startsWith('http') || file.startsWith('data:')) {
                    return;
                }
                knownFileFullPaths.add(path.normalize(path.join(this.directories.root, file)));
            });
            const files = await fs.promises.readdir(this.directories.files, { withFileTypes: true });
            for (const file of files) {
                // SillyBunny: Chat Archive organization metadata is app state, not a loose upload.
                if (file.name === '_sbca_organization.json') {
                    continue;
                }
                // SillyBunny: imported fonts are listed in settings.json, not referenced by chats, so they would look loose.
                if (file.name.startsWith('sb-font-')) {
                    continue;
                }
                const filePath = path.join(this.directories.files, file.name);
                if (file.isFile() && !knownFileFullPaths.has(filePath)) {
                    result.push(filePath);
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting user files:', error);
        }

        return result;
    }

    /**
     * Collects loose character chats from the provided directories.
     * Chat folders are considered loose if they don't have corresponding character files.
     * @returns {Promise<string[]>} List of paths to loose character chats
     */
    async #collectChats() {
        const result = [];

        try {
            const knownChatFolders = new Set();
            const characters = await fs.promises.readdir(this.directories.characters, { withFileTypes: true });
            for (const file of characters) {
                if (file.isFile() && path.parse(file.name).ext === '.png') {
                    knownChatFolders.add(file.name.replace('.png', ''));
                }
            }
            const chatFolders = await fs.promises.readdir(this.directories.chats, { withFileTypes: true });
            for (const folder of chatFolders) {
                if (folder.isDirectory() && !knownChatFolders.has(folder.name)) {
                    const chatFiles = await fs.promises.readdir(path.join(this.directories.chats, folder.name), { withFileTypes: true });
                    for (const file of chatFiles) {
                        if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                            result.push(path.join(this.directories.chats, folder.name, file.name));
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting character chats:', error);
        }

        return result;
    }

    /**
     * Collects loose group chats from the provided directories.
     * Group chat files are considered loose if they're not referenced by any group definition.
     * @returns {Promise<string[]>} List of paths to loose group chats
     */
    async #collectGroupChats() {
        const result = [];

        try {
            const groups = await fs.promises.readdir(this.directories.groups, { withFileTypes: true });
            const knownGroupChats = new Set();
            for (const file of groups) {
                if (file.isFile() && path.parse(file.name).ext === '.json') {
                    try {
                        const pathToFile = path.join(this.directories.groups, file.name);
                        const fileContent = await fs.promises.readFile(pathToFile, 'utf-8');
                        const groupData = tryParse(fileContent);
                        if (groupData?.chat_id) {
                            knownGroupChats.add(groupData.chat_id);
                        }
                        if (Array.isArray(groupData?.chats)) {
                            for (const chat of groupData.chats) {
                                knownGroupChats.add(chat);
                            }
                        }
                    } catch (error) {
                        console.error(`[Data Maid] Error parsing group chat file ${file.name}:`, error);
                    }
                }
            }
            const groupChats = await fs.promises.readdir(this.directories.groupChats, { withFileTypes: true });
            for (const file of groupChats) {
                if (file.isFile() && path.parse(file.name).ext === '.jsonl') {
                    if (!knownGroupChats.has(path.parse(file.name).name)) {
                        result.push(path.join(this.directories.groupChats, file.name));
                    }
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting group chats:', error);
        }

        return result;
    }

    /**
     * Collects loose avatar thumbnails from the provided directories.
     * @returns {Promise<string[]>} List of paths to loose avatar thumbnails
     */
    async #collectAvatarThumbnails() {
        const result = [];

        try {
            const knownAvatars = new Set();
            const avatars = await fs.promises.readdir(this.directories.characters, { withFileTypes: true });
            for (const file of avatars) {
                if (file.isFile()) {
                    knownAvatars.add(file.name);
                }
            }
            // SillyBunny: include mobile avatar thumbnails alongside desktop thumbnails.
            for (const thumbnailDirectory of [this.directories.thumbnailsAvatar, this.directories.thumbnailsAvatarMobile]) {
                if (!thumbnailDirectory || !fs.existsSync(thumbnailDirectory)) {
                    continue;
                }
                const avatarThumbnails = await fs.promises.readdir(thumbnailDirectory, { withFileTypes: true });
                for (const file of avatarThumbnails) {
                    if (file.isFile() && !knownAvatars.has(file.name)) {
                        result.push(path.join(thumbnailDirectory, file.name));
                    }
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting avatar thumbnails:', error);
        }

        return result;
    }

    /**
     * Collects loose background thumbnails from the provided directories.
     * @returns {Promise<string[]>} List of paths to loose background thumbnails
     */
    async #collectBackgroundThumbnails() {
        const result = [];

        try {
            const knownBackgrounds = new Set();
            const backgrounds = await fs.promises.readdir(this.directories.backgrounds, { withFileTypes: true });
            for (const file of backgrounds) {
                if (file.isFile()) {
                    knownBackgrounds.add(file.name);
                }
            }
            for (const thumbnailDirectory of [this.directories.thumbnailsBg, this.directories.thumbnailsBgMobile]) {
                const backgroundThumbnails = await fs.promises.readdir(thumbnailDirectory, { withFileTypes: true });
                for (const file of backgroundThumbnails) {
                    if (file.isFile() && !knownBackgrounds.has(file.name)) {
                        result.push(path.join(thumbnailDirectory, file.name));
                    }
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting background thumbnails:', error);
        }

        return result;
    }

    /**
     * Collects loose persona thumbnails from the provided directories.
     * @returns {Promise<string[]>} List of paths to loose persona thumbnails
     */
    async #collectPersonaThumbnails() {
        const result = [];

        try {
            const knownPersonas = new Set();
            const personas = await fs.promises.readdir(this.directories.avatars, { withFileTypes: true });
            for (const file of personas) {
                if (file.isFile()) {
                    knownPersonas.add(file.name);
                }
            }
            // SillyBunny: include mobile persona thumbnails alongside desktop thumbnails.
            for (const thumbnailDirectory of [this.directories.thumbnailsPersona, this.directories.thumbnailsPersonaMobile]) {
                if (!thumbnailDirectory || !fs.existsSync(thumbnailDirectory)) {
                    continue;
                }
                const personaThumbnails = await fs.promises.readdir(thumbnailDirectory, { withFileTypes: true });
                for (const file of personaThumbnails) {
                    if (file.isFile() && !knownPersonas.has(file.name)) {
                        result.push(path.join(thumbnailDirectory, file.name));
                    }
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting persona thumbnails:', error);
        }

        return result;
    }

    /**
     * Collects chat backups from the provided directories.
     * @returns {Promise<string[]>} List of paths to chat backups
     */
    async #collectChatBackups() {
        const result = [];

        try {
            const prefix = CHAT_BACKUPS_PREFIX;
            const backups = await fs.promises.readdir(this.directories.backups, { withFileTypes: true });
            for (const file of backups) {
                if (file.isFile() && file.name.startsWith(prefix)) {
                    result.push(path.join(this.directories.backups, file.name));
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting chat backups:', error);
        }

        return result;
    }

    /**
     * Collects settings backups from the provided directories.
     * @returns {Promise<string[]>} List of paths to settings backups
     */
    async #collectSettingsBackups() {
        const result = [];

        try {
            const prefix = getSettingsBackupFilePrefix(this.handle);
            const backups = await fs.promises.readdir(this.directories.backups, { withFileTypes: true });
            for (const file of backups) {
                if (file.isFile() && file.name.startsWith(prefix)) {
                    result.push(path.join(this.directories.backups, file.name));
                }
            }
        } catch (error) {
            console.error('[Data Maid] Error collecting settings backups:', error);
        }

        return result;
    }

    /**
     * Generates a unique token for the user to clean up their data.
     * Replaces any existing token for the same user.
     * @param {string} handle - The user's handle or identifier.
     * @param {DataMaidRawReport} report - The report containing loose user data.
     * @returns {string} A unique token.
     */
    static generateToken(handle, report) {
        // Remove any existing token for this user
        for (const [token, entry] of this.TOKENS.entries()) {
            if (entry.handle === handle) {
                this.TOKENS.delete(token);
            }
        }

        const token = crypto.randomBytes(32).toString('hex');
        const tokenEntry = {
            handle,
            paths: Object.values(report).filter(v => Array.isArray(v)).flat().map(x => ({ path: x, hash: sha256(x) })),
        };
        this.TOKENS.set(token, tokenEntry);
        return token;
    }
}

export const router = express.Router();

router.post('/report', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        const dataMaid = new DataMaidService(req.user.profile.handle, req.user.directories);
        const rawReport = await dataMaid.generateReport();

        const report = await dataMaid.sanitizeReport(rawReport);
        const token = DataMaidService.generateToken(req.user.profile.handle, rawReport);

        return res.json({ report, token });
    } catch (error) {
        console.error('[Data Maid] Error generating data maid report:', error);
        return res.sendStatus(500);
    }
});

router.post('/finalize', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        if (!req.body.token) {
            return res.sendStatus(400);
        }

        const token = req.body.token.toString();
        if (!DataMaidService.TOKENS.has(token)) {
            return res.sendStatus(403);
        }

        const tokenEntry = DataMaidService.TOKENS.get(token);
        if (!tokenEntry || tokenEntry.handle !== req.user.profile.handle) {
            return res.sendStatus(403);
        }

        // Remove the token after finalization
        DataMaidService.TOKENS.delete(token);
        return res.sendStatus(204);
    } catch (error) {
        console.error('[Data Maid] Error finalizing the token:', error);
        return res.sendStatus(500);
    }
});

router.get('/view', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        if (!req.query.token || !req.query.hash) {
            return res.sendStatus(400);
        }

        const token = req.query.token.toString();
        const hash = req.query.hash.toString();

        if (!DataMaidService.TOKENS.has(token)) {
            return res.sendStatus(403);
        }

        const tokenEntry = DataMaidService.TOKENS.get(token);
        if (!tokenEntry || tokenEntry.handle !== req.user.profile.handle) {
            return res.sendStatus(403);
        }

        const fileEntry = tokenEntry.paths.find(entry => entry.hash === hash);
        if (!fileEntry) {
            return res.sendStatus(404);
        }

        if (!isPathUnderParent(req.user.directories.root, fileEntry.path)) {
            console.warn('[Data Maid] Attempted access to a file outside of the user directory:', fileEntry.path);
            return res.sendStatus(403);
        }

        const pathToFile = fileEntry.path;
        const isDirectCharacterCard = path.dirname(path.resolve(pathToFile)) === path.resolve(req.user.directories.characters)
            && path.extname(pathToFile).toLowerCase() === '.png';
        if (isDirectCharacterCard) {
            recoverFileWriteSync(pathToFile);
        }
        const fileExists = fs.existsSync(pathToFile);

        if (!fileExists) {
            return res.sendStatus(404);
        }

        const fileBuffer = await fs.promises.readFile(pathToFile);
        const mimeType = mime.lookup(pathToFile) || 'text/plain';
        res.setHeader('Content-Type', mimeType);
        return res.send(fileBuffer);
    } catch (error) {
        console.error('[Data Maid] Error viewing file:', error);
        return res.sendStatus(500);
    }
});

router.post('/delete', async (req, res) => {
    try {
        if (!req.user || !req.user.directories) {
            return res.sendStatus(403);
        }

        const { token, hashes } = req.body;
        if (!token || !Array.isArray(hashes) || hashes.length === 0) {
            return res.sendStatus(400);
        }

        if (!DataMaidService.TOKENS.has(token)) {
            return res.sendStatus(403);
        }

        const tokenEntry = DataMaidService.TOKENS.get(token);
        if (!tokenEntry || tokenEntry.handle !== req.user.profile.handle) {
            return res.sendStatus(403);
        }

        for (const hash of hashes) {
            const fileEntry = tokenEntry.paths.find(entry => entry.hash === hash);
            if (!fileEntry) {
                continue;
            }

            if (!isPathUnderParent(req.user.directories.root, fileEntry.path)) {
                console.warn('[Data Maid] Attempted deletion of a file outside of the user directory:', fileEntry.path);
                continue;
            }

            const pathToFile = fileEntry.path;
            const fileExists = fs.existsSync(pathToFile);

            if (!fileExists) {
                continue;
            }

            await fs.promises.unlink(pathToFile);
        }

        return res.sendStatus(204);
    } catch (error) {
        console.error('[Data Maid] Error deleting files:', error);
        return res.sendStatus(500);
    }
});
