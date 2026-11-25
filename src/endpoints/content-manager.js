import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import express from 'express';
import fetch from 'node-fetch';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue, color, recoverFileWriteSync, setPermissionsSync, isValidUrl } from '../util.js';
import { write } from '../character-card-parser.js';
import { serverDirectory } from '../server-directory.js';
import { Jimp, JimpMime } from '../jimp.js';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
// SillyBunny: bundled assistant cards, sprites and worlds that nobody edited are brought up to date in the per-user pass, and a replaced card loses its cached thumbnails.
import {
    createManagedContent,
    describePathSignature,
    readAppVersionSignature,
    readReconcileMarker,
    reconcileManagedContentWithStatus,
    writeReconcileMarker,
} from '../sillybunny-managed-content.js';
import { invalidateThumbnail } from './thumbnails.js';

const contentDirectory = path.join(serverDirectory, 'default/content');
const scaffoldDirectory = path.join(serverDirectory, 'default/scaffold');
const contentIndexPath = path.join(contentDirectory, 'index.json');
const scaffoldIndexPath = path.join(scaffoldDirectory, 'index.json');
const DEFAULT_PRESET_DELETIONS_FILE = 'default-preset-deletions.json';

const WHITELIST_GENERIC_URL_DOWNLOAD_SOURCES = getConfigValue('whitelistImportDomains', []);
const USER_AGENT = 'SillyTavern';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * @param {Buffer} buffer Image buffer
 * @returns {boolean} True if the buffer starts with a PNG signature
 */
function isPngBuffer(buffer) {
    return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * @param {unknown} error Error object
 * @returns {string} Error message with cause when available
 */
function getErrorMessage(error) {
    if (error instanceof Error) {
        const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
        return `${error.message}${cause}`;
    }

    return String(error);
}

/**
 * @param {string | null} contentDisposition Content-Disposition header
 * @returns {string | null} Decoded filename from the header
 */
function getFileNameFromContentDisposition(contentDisposition) {
    const fileNameMatch = contentDisposition?.match(/filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i);
    const fileName = fileNameMatch?.[1] || fileNameMatch?.[2];

    if (!fileName) {
        return null;
    }

    try {
        return decodeURIComponent(fileName.replace(/^"|"$/g, ''));
    } catch {
        return fileName.replace(/^"|"$/g, '');
    }
}

/**
 * @param {unknown} name Desired file name
 * @param {string} fallbackName Fallback file name
 * @returns {string} Sanitized PNG file name
 */
function getPngFileName(name, fallbackName = 'character') {
    const safeFallback = sanitize(String(fallbackName || 'character')) || 'character';
    const safeName = sanitize(String(name || safeFallback)) || safeFallback;

    return safeName.toLowerCase().endsWith('.png') ? safeName : `${safeName}.png`;
}

/**
 * @typedef {Object} ContentItem
 * @property {string} filename
 * @property {string} type
 * @property {string} [name]
 * @property {string|null} [folder]
 */

/**
 * @typedef {string} ContentType
 * @enum {string}
 */
export const CONTENT_TYPES = {
    SETTINGS: 'settings',
    CHARACTER: 'character',
    SPRITES: 'sprites',
    BACKGROUND: 'background',
    WORLD: 'world',
    AVATAR: 'avatar',
    THEME: 'theme',
    WORKFLOW: 'workflow',
    KOBOLD_PRESET: 'kobold_preset',
    OPENAI_PRESET: 'openai_preset',
    NOVEL_PRESET: 'novel_preset',
    TEXTGEN_PRESET: 'textgen_preset',
    INSTRUCT: 'instruct',
    CONTEXT: 'context',
    MOVING_UI: 'moving_ui',
    QUICK_REPLIES: 'quick_replies',
    SYSPROMPT: 'sysprompt',
    REASONING: 'reasoning',
    ERROR_PAGE: 'error_page',
    STYLESHEET: 'stylesheet',
};

export const PRESET_CONTENT_TYPES = Object.freeze([
    CONTENT_TYPES.KOBOLD_PRESET,
    CONTENT_TYPES.OPENAI_PRESET,
    CONTENT_TYPES.NOVEL_PRESET,
    CONTENT_TYPES.TEXTGEN_PRESET,
    CONTENT_TYPES.INSTRUCT,
    CONTENT_TYPES.CONTEXT,
    CONTENT_TYPES.SYSPROMPT,
    CONTENT_TYPES.REASONING,
]);

// SillyBunny divergence: remove superseded bundled preset files from user data
// during the existing default content update pass, without adding new metadata.
const OBSOLETE_CONTENT_ITEMS = Object.freeze([
    { filename: 'presets/openai/Geechan - Universal Roleplay (Chat Completions) (v5.0).json', type: CONTENT_TYPES.OPENAI_PRESET },
    { filename: 'presets/context/Geechan - Universal Roleplay (V5.0).json', type: CONTENT_TYPES.CONTEXT },
    { filename: 'presets/sysprompt/Geechan - Universal Roleplay (V5.0).json', type: CONTENT_TYPES.SYSPROMPT },
    { filename: 'presets/sysprompt/Geechan - Universal Roleplay (NSFW) (V5.0).json', type: CONTENT_TYPES.SYSPROMPT },
    { filename: 'presets/sysprompt/Geechan - Universal Roleplay (Simplified) (V5.0).json', type: CONTENT_TYPES.SYSPROMPT },
    { filename: 'presets/sysprompt/Geechan - Universal Roleplay (NSFW Simplified) (V5.0).json', type: CONTENT_TYPES.SYSPROMPT },
]);

// SillyBunny divergence: reconcile only the bundled Memory Sharding quick reply
// during the existing default content pass. Hash-gating keeps user-authored or
// edited files untouched, repeated runs stay idempotent, and staleHashes is a
// migration ledger for future bundled prompt updates.
const MANAGED_BUNDLED_QUICK_REPLIES = Object.freeze([
    {
        bundledPath: 'presets/quick-replies/Memory Sharding.json',
        staleHashes: Object.freeze([]),
    },
]);

// SillyBunny divergence: seeding never overwrites an existing theme file, so a bundled theme that changes
// after users copied it would stay stale in their data folder. A managed theme is replaced only while the
// user's copy has the SHA-256 of an earlier bundled file; an edited copy has another hash and is left alone.
// The Libadwaita Light entry lists the files of its pre-release builds, the last of them from before its text colours
// were raised to the DESIGN.md contrast floor. CONTRAST_REVISED_THEME_HASHES maps every other
// theme that had text colours raised to the hash of its file from before. A value is one hash, or an array of
// hashes when pre-release builds also shipped an earlier revision of the file (the first entry is the last release's).
const CONTRAST_REVISED_THEME_HASHES = Object.freeze({
    'Amber Dusk': [
        '8f82f538222d0c006c49acb8c9246fcc434a67fed004153a708ff1fbca92d848',
        '605bad6844d5c1bbf5f5a953cdd1ccf7ffe9cfa577fd558d40ee9c498c6b8d1f',
    ],
    Azure: [
        '87426170fa7018df583aeda71f440ceb8f6234794265b6427371706d7fb064b1',
        '74959a9c276c60e4d1deaab37f6cc6b0b2f2fd2246184aac59d9cb014beaa0f0',
    ],
    'Burnt Orange': [
        '2cde7d3f33c697ce1a70173c873722c5a814bf8580caf743680ad84ca5b7c988',
        '873c70e6bf24b5207865c89343acaeb338ec871888778fc3f54f92f2078cfc78',
    ],
    Cappuccino: '06cea473697a1fd4042a3a57f40b1194c1d1db577b253486b893f3c17e941b95',
    'Catppuccin Latte': [
        '0a9d693c0f8f864eb4e4c104c7ea04ed18d3adfcd71cc5d02dcf85fb73b57a8c',
        'ef4426efa9aea5f9ecccf02f3be32dec7d8b0af79f0032b69e30980803612f2d',
    ],
    'Catppuccin Mocha': [
        '4b437cb39d8aaf614c6d010f0bf388e17f175b4bedc2bf4816e1c0f679ec8ee4',
        '9eeb768830f556359701b3c332a274c943440f8c695451bff3f41aedee92695d',
    ],
    'Celestial Macaron': 'd670ff830f0b4184d44fdc689bf394c33e0cd0d47b99e15026ac14fc008561e0',
    Cerulean: [
        '499b1744aa6d861ae12a94b28c09654a83cb809676d158b8c8e681b3719fdf83',
        '8058cd14dabd182bcc8f9a2b31a3426332b31cff412c84b061cff85172ac7704',
    ],
    Cinder: [
        'a163b45775fe91c41ad631442fcdd7dbecb5075f4e208fe0789f541d4ec9fb1a',
        '5405e21c56021529831098d7e82c68471d8169ddd2b3859937b57194ae218400',
    ],
    'Dark Lite': 'f894d42f22426d645f4b742ecf927a5901540050c26de3524bf9b3990c49f497',
    'Dark V 1.0': 'cda9c1274c89350bc35c29ebca0edf251fd8b10be2b94f060c5b2a47b68d7018',
    Dracula: [
        'c2bc89024d193955028b24d602568004e9b85d0ee0b6982e5273d35bfa497317',
        '1ba1d5ce34c621ff08473a08c6c5bf75753e05407b639805c58ea2cb7fc34cf8',
    ],
    'Dracula Light': [
        'fe0bcf898a273b6a4f9f18bae92829130d6c7facfd1eb6757d50e26839faf3e6',
        '567dc2d4d06abdfc92981507127ab2fcd280801369a3499144aa065020b4be5d',
    ],
    'Everforest Dark': [
        '1314da6c6174a33a4c9721638bec3e711fac5d96bac0375968d901219c4b6a19',
        'dccf9d8382cc4fec3170f0046ad423c6201dd1f4ee7b7268ee0d7acd50d7fec5',
    ],
    'Everforest Light': [
        '448b6acab6b2194c39c6f44a990dbf4dc33d482d70bbd6a8e559b980d0a5135b',
        'e01b47dea044b6739ccef047aa36833c8cd506b4795883837169e1f0c701a979',
    ],
    Glacier: [
        '330021d9fb6182c7433037a2ef950ed86170a3e4683a3c149d6ded88ecb6d660',
        '7b3f8ebf13e5f8cd5294e2f0c60397234dc12b1c7a37b246edbf508554fb21e7',
    ],
    'Gruvbox Dark': [
        'dc2917da738305e3d3eb0d3336042505f28d081f8c98b6fad5f06efd00d75445',
        '096bdae184d865a13397f2c9885e238dbbe93269debfaeed48c20364b8b35978',
    ],
    'Gruvbox Light': [
        '676929397107f356e222d9f0668eef72679ceb062ed904047726a72a4e65c0f7',
        'b7f256fed7b35ad8732979ec3bed7e1e532b3faa1e642ab08168c5d30320aa2c',
    ],
    'Hacker-Terminal-Light': [
        'fa555e534a2ae0cf61a60ad5207b7e8823e43e7565e88d93889cb1841cd50672',
        '29e64f1c60de4c513a317858f52ea64a0fa8fb14d957b3b385b525c2b21c438c',
    ],
    Lavender: [
        '55aa33a93b8f678717d47ad109b1f95c32f6bad7d578c2135fd28b15840cd936',
        '08f3f49e214eb2bcb9c79bf476ba828dc3485f331df6a599015f4b70e6fb643a',
    ],
    Lime: [
        '90cddb5b87d3c0368f7473214498bdf3a922785704d08c055ef4496a3979797b',
        'e71545164e248260968225504fcadc49730bd83174bc7be39b239f8127ca763c',
    ],
    Magenta: [
        'a8d41ba8b0252d3b137acbb012a8b776f5919329e955922a0e51c70c8a7dc9c6',
        'd658ab7233a27e2c05064fb824b6e68374569605c9079535d26a3976f2047722',
    ],
    Mint: [
        'f53fc0bbf962a4c8d84e3ea8e03edf72b643956a1019771ad34a4681c9bc29b2',
        'f99f6a0de58c843db06da164e2d5f11cf1a328543afae8407ae1c034673a0ed8',
    ],
    Monochrome: [
        'fe6606c7ff5697878280da1431530c7d8c7947cac69173dbc4c39f475030b339',
        'f3d67363e2e85e1706b9f9ab014e8aee3008b4e1de9ee79c930fa57769d881b0',
    ],
    'Neon Abyss': [
        'ebef37330912ed4a0ddbf28d316b358b9a766f877950a1ecf5628e1bdb145da3',
        '5425b2e480f4c383f46602a3d4f29cfd994b1d77069d6f8e2fbd37573a15960e',
    ],
    'Neon Yellow': [
        '9965a3b7cac8c6f1ac8e2037d3fdcbae1562c61b8b6b4063517b5086ce4de7c1',
        '5543184dc885233a44bd7b2cd01e674587c6989edff8adaf738a088c94025e96',
    ],
    Nord: [
        '4f652df094a96403fe38cb47f9b0b27c0e0ea66356df291cfd428ee7c125b14f',
        '19107c7937aaf1e8a21f14baed85519b7f026a2b55fa5e74f2110c151a258fab',
    ],
    'Nord Light': [
        '39b971d8c8a7140b4c66bb6a3b1a4c46280a0508d883d77bbdd092b13e63e671',
        '93a579bfb8ccf84b409275d582f84f00b17a597fc5aef84755e7098379c65ecd',
    ],
    Plum: [
        'e9927741990141dd73e6a9778e0b0458051e211e81c74485f47babfed35a439e',
        'c0795d29ede23803fcc6e839e323db784b8e2e7a26bd4dd317db040a1480c0c6',
    ],
    Rose: [
        'df951ec20b01efdd76cde448e6049df45a1180d5d71b322dd71a8450c282ab95',
        'c72cc90a732f3480d1d889b1f93db00602644e401dd1ee3f4f635e2411a0affc',
    ],
    'Rosé Pine': [
        'ae8c33dde31b5410ac1fd1ea8ffe95387a952d6018881b61525959ab88ad4854',
        '2fa4ce7372df21e82fb80ce3a38234e3a10a47dc21f0c85502af073aca973d06',
    ],
    'Rosé Pine Dawn': [
        '2056de45032c4f23c56caeab37b7562ed6c23c0ce329be1672ecbde5edc3958e',
        '66ea41e69c570e3e0231b7a22daa3da6a38d946b9aa273a2be5a89c2f2932d23',
    ],
    Sage: [
        'bbfcef2913e10ae3d48c08dde23a79d931ce01723668f6f8128063ec658b7ce7',
        '49c298d5a4eb939b1e8e8d29a62e80689927fd5d48e76d563e1ebd4b9f9fc855',
    ],
    Slate: [
        'cf80b17b2c4ef1d133830d17f0c7a2de5e8a9e262e9736b46facd1ef34f0ef2d',
        '1a30ea76873cd5254c4235fa4d60eeb522209f19d6cdaaacfab21899ca4841f3',
    ],
    'Solarized Dark': [
        'c8d84b6f3ce7e1e2c75df81aa5cffe90eed69c8109ecd70babc0f27a1ac10a6e',
        '322051819bea3c5a85874d490cede036959ab660bae39ac765a3b38ecf0a75fd',
    ],
    'Solarized Light': [
        'f84c47d1e427fff57cde2ce8cd8f2bf031837ec568561bc4402bd2b3af7bd41f',
        '92752cb6c794d2c56d95e5c163a511464b38035ddcf60c700653a44d112d73ba',
    ],
    'Sonokai Andromeda': [
        '27d9c84e863e5b3087b47d9c41d9cde153ba7fcdccef1583be5343db30e2f0b1',
        '0083859ecdba7bd8ecde039ffbd0f491a430d78e239a34011f97e518db848f72',
    ],
    'Sonokai Andromeda Light': [
        '0872ccb77466781c2bd91ec2b6e67a17ff4143402b6bda8a5259101580129275',
        '55a4369ec91b2007bb8712f7e3c154c7a05eaeab877294c07e7f1af1cbcac3c7',
    ],
    'Sonokai Atlantis': [
        '3dd8c04362cbbda64f041121052f687dcacfa87ec976a9ab94b5a5bbb05c7292',
        '7c3cb026954c8aeabdfc0678364b30e1a497a12f18bbf463bf30f8c3215a76db',
    ],
    'Sonokai Atlantis Light': [
        'ad12b5ecf8f42fd3cb72de7e4a9b33b5a505d547039e818353602beb83e3c2bf',
        '9e1810ac8ea689dc881eea53a7046dcabcd4f831a5356b592e34a2cc13e32bfe',
    ],
    'Sonokai Default': [
        '1df968101c458f1661c5bcb3678fb9f300a66019a5525c41d974d88873df20ce',
        'd9eeeb3f572321b538c029ab4fe3b2040f0d3f597f8651add5e9a8f01fc06912',
    ],
    'Sonokai Default Light': [
        '85de22d75041b5debb0ab5635dfcd8f00111780d7c8fa3e2679e3053e7440e46',
        '57db8001edb08f5947d584dd54714cb5e757fd87cc9843052f78022415c54765',
    ],
    'Sonokai Espresso': '93e21b80027281643663cff6a8bda5888550fa0757641aa4b7a0691f08c88f3e',
    'Sonokai Espresso Light': [
        '1a0a28b6db578f3a8d391db2fbe5b30d663cc981a746a7afe0ef4cb63956669d',
        '97ff7346a1f6ad0b557abd2456e1e42419ce6e8fae69d8c96a45d9a7ec9f05c5',
    ],
    'Sonokai Maia': [
        '82b443123a5dd13d0d8a5280e56cc7bd1a0d6db182ad1c1e713fa992e9634f7b',
        'b542a609ee948dbaecabc1eed7e6af96feb6a42d7d75f60d3cbccd860867ad20',
    ],
    'Sonokai Maia Light': [
        '0b1880cc056959f28f42524cdaaa74f61f3d31b1d6280273ced726d533e89bef',
        '6557a90b232ede7c9360199461292439d87dc76e8aa9b5affb2e85c18b423f00',
    ],
    'Sonokai Shusia': [
        '02781a915b2fc3f0e5e2c5ec34d402e2c0dfac84bad96b6feda85e780f2badc7',
        '22fe7f05c06826e2e305f041b4a9c2d5ccbb85305db64c04761215efa5fc83e7',
    ],
    'Sonokai Shusia Light': [
        '82d2b8f3473066874f1c8302ebec61c39f288ffa45e4ac3f70e324b1c959338f',
        'b9c8914522a6c3714403d588d5591e73da3d458e7e32e1385431e071ca436cce',
    ],
    'Tokyo Night': [
        '9317ef4b915372eaf01fa7355a1e8cd13cf82c79ab07a7a9082b76cd01e1d53d',
        'd3abe4df3bf554f9ea23f5a9167db7a18fdca108e5f156e4075702fe8e505baa',
    ],
    'Tokyo Night Day': [
        '9b3c57d38826a79885db4332ef2751c043aee2ef2ec25063c923f1f00e31a803',
        'e77c706371e3a5a67a16e04a5817a299a89f0ec34d04beffebe6ce558ba01288',
    ],
    'Verdant Light': [
        'dfc5acb859d8821d4dc77ad37fa8314b670fcdbc535f758318da4192ba38a493',
        '8f3228635d7eee2765e2e8d439b8d1393f0f03f3095d78ad692433a9f2d01604',
    ],
});

// SillyBunny divergence: the bundled theme "Libadwaita" is now "Libadwaita Dark". A user's `Libadwaita.json` is
// deleted only while its SHA-256 is listed here, which covers every version that was shipped. An edited copy has
// another hash, stays, and becomes the user's own theme. The client selects "Libadwaita Dark" for a user whose
// selected theme no longer exists.
const RETIRED_BUNDLED_THEMES = Object.freeze([
    {
        filename: 'Libadwaita.json',
        shippedHashes: Object.freeze([
            'ce420dcde11cec505b2112515e1aeccea5937768911971817f3089c96f412b97',
            'c0e039effbc0c83883b551d4e74b2c29a506079f09f9e2a66b3b6659cd7c536d',
            'afcaa383c6b4ab81a3704e6f58eaec18eeaff63d9c95d0de76a4ef1ca75c30d9',
            'c09b7f589beab4cc8e752e74c37a31f39cdda2a540b7e1e5ce0314eccc53c2dd',
        ]),
    },
]);

const MANAGED_BUNDLED_THEMES = Object.freeze([
    {
        bundledPath: 'themes/Libadwaita Light.json',
        staleHashes: Object.freeze([
            '750603511a68a6823629bf706a095f728fadcc80f11af8321a109d237566bbb1',
            'fdfc96c9fd2b29d2dc76104911c2f452830067352e07f20c5fb6b26604121f45',
            'f7cba0d205b5fd26fa1fb28da45a66d3bf7eee2bdde95133680a6adf98d2eea8',
        ]),
    },
    ...Object.entries(CONTRAST_REVISED_THEME_HASHES).map(([name, staleHashes]) => ({
        bundledPath: `themes/${name}.json`,
        staleHashes: Object.freeze(Array.isArray(staleHashes) ? staleHashes : [staleHashes]),
    })),
]);

function isPresetContentType(type) {
    return PRESET_CONTENT_TYPES.includes(type);
}

function getDefaultPresetDeletionPath(directories) {
    return path.join(directories.root, DEFAULT_PRESET_DELETIONS_FILE);
}

function getDefaultPresetDeletionKey(contentItem) {
    return `${contentItem.type}::${contentItem.filename}`;
}

function normalizePresetDeletionData(data) {
    const normalized = { version: 1, deleted: {} };

    if (!data || typeof data !== 'object') {
        return normalized;
    }

    const source = data.deleted && typeof data.deleted === 'object' ? data.deleted : data;

    if (Array.isArray(source)) {
        for (const item of source) {
            if (!item || typeof item !== 'object' || !item.type || !item.filename) {
                continue;
            }

            normalized.deleted[getDefaultPresetDeletionKey(item)] = {
                type: String(item.type),
                filename: String(item.filename),
                deletedAt: Number(item.deletedAt) || Date.now(),
            };
        }

        return normalized;
    }

    for (const [key, value] of Object.entries(source)) {
        if (value === true) {
            const [type, filename] = key.split('::');
            if (type && filename) {
                normalized.deleted[key] = { type, filename, deletedAt: Date.now() };
            }
            continue;
        }

        if (!value || typeof value !== 'object' || !value.type || !value.filename) {
            continue;
        }

        normalized.deleted[getDefaultPresetDeletionKey(value)] = {
            type: String(value.type),
            filename: String(value.filename),
            deletedAt: Number(value.deletedAt) || Date.now(),
        };
    }

    return normalized;
}

export function getDefaultPresetDeletions(directories) {
    try {
        const deletionPath = getDefaultPresetDeletionPath(directories);
        if (!fs.existsSync(deletionPath)) {
            return { version: 1, deleted: {} };
        }

        return normalizePresetDeletionData(JSON.parse(fs.readFileSync(deletionPath, 'utf8')));
    } catch (error) {
        console.warn('Failed to read default preset deletions', error);
        return { version: 1, deleted: {} };
    }
}

function writeDefaultPresetDeletions(directories, deletions) {
    const normalized = normalizePresetDeletionData(deletions);
    const deletionPath = getDefaultPresetDeletionPath(directories);

    fs.mkdirSync(path.dirname(deletionPath), { recursive: true });
    writeFileAtomicSync(deletionPath, `${JSON.stringify(normalized, null, 4)}\n`, 'utf8');
}

export function isDefaultPresetDeleted(directories, contentItem) {
    if (!contentItem || !isPresetContentType(contentItem.type)) {
        return false;
    }

    const deletions = getDefaultPresetDeletions(directories);
    return Object.hasOwn(deletions.deleted, getDefaultPresetDeletionKey(contentItem));
}

export function recordDefaultPresetDeletion(directories, contentItem) {
    if (!contentItem || !isPresetContentType(contentItem.type)) {
        return false;
    }

    const deletions = getDefaultPresetDeletions(directories);
    const key = getDefaultPresetDeletionKey(contentItem);
    deletions.deleted[key] = {
        type: contentItem.type,
        filename: contentItem.filename,
        deletedAt: Date.now(),
    };
    writeDefaultPresetDeletions(directories, deletions);
    return true;
}

export function clearDefaultPresetDeletion(directories, contentItem) {
    if (!contentItem || !isPresetContentType(contentItem.type)) {
        return false;
    }

    const deletions = getDefaultPresetDeletions(directories);
    const key = getDefaultPresetDeletionKey(contentItem);

    if (!Object.hasOwn(deletions.deleted, key)) {
        return false;
    }

    delete deletions.deleted[key];
    writeDefaultPresetDeletions(directories, deletions);
    return true;
}

/**
 * @enum {string}
 */
export const CONTENT_SCOPE = {
    USER: 'user',
    GLOBAL: 'global',
};

/**
 * Gets the scope of a content type.
 * @param {CONTENT_TYPES} type Content type
 * @returns {CONTENT_SCOPE} Resolved content scope
 */
function getScopeByType(type) {
    const globalTypes = [
        CONTENT_TYPES.ERROR_PAGE,
        CONTENT_TYPES.STYLESHEET,
    ];
    return globalTypes.includes(type) ? CONTENT_SCOPE.GLOBAL : CONTENT_SCOPE.USER;
}

/**
 * Gets the default presets from the content directory.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {object[]} Array of default presets
 */
export function getDefaultPresets(directories, { includeDeleted = true } = {}) {
    try {
        const contentIndex = getContentIndex(CONTENT_SCOPE.USER);
        // SillyBunny: parse default-preset-deletions.json once per call instead of once per preset entry.
        const presetDeletions = includeDeleted ? null : getDefaultPresetDeletions(directories);
        const presets = [];

        for (const contentItem of contentIndex) {
            if (isPresetContentType(contentItem.type)) {
                if (!includeDeleted && Object.hasOwn(presetDeletions.deleted, getDefaultPresetDeletionKey(contentItem))) {
                    continue;
                }

                presets.push({
                    ...contentItem,
                    name: path.parse(contentItem.filename).name,
                    folder: getUserTargetByType(contentItem.type, directories),
                    sourceFolder: contentItem.folder,
                });
            }
        }

        return presets;
    } catch (err) {
        console.warn('Failed to get default presets', err);
        return [];
    }
}

/**
 * Finds a bundled default preset by target folder and display name.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} options Lookup options
 * @param {string} options.folder Target folder
 * @param {string} options.name Preset name without extension
 * @returns {ContentItem|null} Default preset item
 */
export function findDefaultPreset(directories, { folder, name }) {
    if (!folder || !name) {
        return null;
    }

    const defaultPresets = getDefaultPresets(directories, { includeDeleted: true });
    return defaultPresets.find(preset => preset.folder === folder && preset.name === name) || null;
}

/**
 * Restores the bundled default preset files that a user is missing, whether they deleted them or never had them.
 * A file that is there is never written over, edited or not: the copy is exclusive, so a file that appears
 * while the restore runs is kept as well. A kept file is not reported as restored.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]|null} types Content types to restore, or null for all preset types
 * @returns {{restored: string[], failed: {filename: string, error: string}[]}} `restored` holds the presets that were written
 */
export function restoreDefaultPresetFiles(directories, types = null) {
    const allowedTypes = Array.isArray(types) && types.length ? new Set(types) : null;
    const defaultPresets = getDefaultPresets(directories, { includeDeleted: true })
        .filter(preset => !allowedTypes || allowedTypes.has(preset.type));
    const restored = [];
    const failed = [];

    for (const preset of defaultPresets) {
        try {
            const sourceFolder = preset.sourceFolder || contentDirectory;
            const sourcePath = path.join(sourceFolder, preset.filename);
            const targetFolder = preset.folder;
            const targetPath = path.join(targetFolder, path.parse(preset.filename).base);

            if (!targetFolder || !fs.existsSync(sourcePath)) {
                throw new Error('Default preset source is missing.');
            }

            fs.mkdirSync(targetFolder, { recursive: true });
            try {
                // SillyBunny: an exclusive copy, so a restore never overwrites a preset that is there.
                fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
            } catch (error) {
                if (error?.code === 'EEXIST') {
                    continue;
                }
                throw error;
            }
            setPermissionsSync(targetPath);
            clearDefaultPresetDeletion(directories, preset);
            restored.push(preset.filename);
        } catch (error) {
            failed.push({
                filename: preset.filename,
                error: error.message || String(error),
            });
        }
    }

    return { restored, failed };
}

/**
 * Gets a default JSON file from the content directory.
 * @param {string} filename Name of the file to get
 * @returns {object | null} JSON object or null if the file doesn't exist
 */
export function getDefaultPresetFile(filename) {
    try {
        const contentPath = path.join(contentDirectory, filename);

        if (!fs.existsSync(contentPath)) {
            return null;
        }

        const fileContent = fs.readFileSync(contentPath, 'utf8');
        return JSON.parse(fileContent);
    } catch (err) {
        console.warn(`Failed to get default file ${filename}`, err);
        return null;
    }
}

// SillyBunny: load content.log once with raw text so unchanged seeding passes avoid rewriting it.
/**
 * @param {string} contentLogPath
 * @returns {{ exists: boolean, rawText: string, entries: string[] }}
 */
function readContentLogState(contentLogPath) {
    if (!fs.existsSync(contentLogPath)) {
        return { exists: false, rawText: '', entries: [] };
    }
    const rawText = fs.readFileSync(contentLogPath, 'utf8');
    return { exists: true, rawText, entries: rawText.split('\n') };
}

/**
 * Seeds content from a content index into a target location.
 * @param {ContentItem[]} contentIndex Content index
 * @param {string} contentLogPath Path to the content log file
 * @param {(type: string) => string | null} resolveTarget Function to resolve the target directory for a content type
 * @param {string[]} [forceCategories] List of categories to force check (even if content check is skipped)
 * @param {{ exists: boolean, rawText: string, entries: string[] }} [logState] Pre-loaded content log state
 * @returns {boolean} Whether any content was added
 */
function seedContent(contentIndex, contentLogPath, resolveTarget, forceCategories, logState = readContentLogState(contentLogPath)) {
    let anyContentAdded = false;
    const contentLog = logState.entries;
    const loggedSet = new Set(contentLog);

    for (const contentItem of contentIndex) {
        const hasLoggedContent = loggedSet.has(contentItem.filename);

        // If the content item is already in the log, skip it
        if (hasLoggedContent && !forceCategories?.includes(contentItem.type)) {
            continue;
        }

        if (!contentItem.folder) {
            console.warn(`Content file ${contentItem.filename} has no parent folder`);
            continue;
        }

        const contentPath = path.join(contentItem.folder, contentItem.filename);

        if (!fs.existsSync(contentPath)) {
            console.warn(`Content file ${contentItem.filename} is missing`);
            continue;
        }

        const contentTarget = resolveTarget(contentItem.type);

        if (!contentTarget) {
            console.warn(`Content file ${contentItem.filename} has unknown type ${contentItem.type}`);
            continue;
        }

        const basePath = path.parse(contentItem.filename).base;
        const targetPath = path.join(contentTarget, basePath);

        if (!hasLoggedContent) {
            contentLog.push(contentItem.filename);
            loggedSet.add(contentItem.filename);
        }

        if (fs.existsSync(targetPath)) {
            if (!hasLoggedContent) {
                console.warn(`Content file ${contentItem.filename} already exists in ${contentTarget}`);
            }
            continue;
        }

        fs.mkdirSync(contentTarget, { recursive: true });
        fs.cpSync(contentPath, targetPath, { recursive: true, force: false });
        setPermissionsSync(targetPath);
        console.info(`Content file ${contentItem.filename} copied to ${contentTarget}`);
        anyContentAdded = true;
    }

    // SillyBunny: rewrite content.log only when absent or when entries actually changed.
    const nextContentLogText = contentLog.join('\n');
    if (!logState.exists || nextContentLogText !== logState.rawText) {
        writeFileAtomicSync(contentLogPath, nextContentLogText);
    }
    return anyContentAdded;
}

/**
 * Removes obsolete bundled content from user data after it has been superseded.
 * @param {string[]} contentLog Array of content log lines
 * @param {import('../users.js').UserDirectoryList} directories User directories
 */
function removeObsoleteContent(contentLog, directories) {
    for (const contentItem of OBSOLETE_CONTENT_ITEMS) {
        const contentLogIndex = contentLog.indexOf(contentItem.filename);

        if (contentLogIndex === -1) {
            continue;
        }

        const contentTarget = getUserTargetByType(contentItem.type, directories);

        if (!contentTarget) {
            continue;
        }

        const basePath = path.parse(contentItem.filename).base;
        const targetPath = path.join(contentTarget, basePath);

        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
            console.info(`Obsolete content file ${contentItem.filename} removed from ${contentTarget}`);
        }

        contentLog.splice(contentLogIndex, 1);
    }
}

function getSha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

function getJsonFilesRecursive(directory, onError) {
    const files = [];

    try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                files.push(...getJsonFilesRecursive(entryPath, onError));
                continue;
            }

            if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json') {
                files.push(entryPath);
            }
        }
    } catch (error) {
        onError?.(error);
        console.warn(`Failed to scan quick replies directory ${directory}`, error);
    }

    return files;
}

/**
 * Reconciles managed bundled quick replies without touching user-modified files.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {boolean} True when every inspected quick reply reconciled without caught errors
 */
export function reconcileManagedBundledQuickReplies(directories) {
    const quickRepliesDirectory = getUserTargetByType(CONTENT_TYPES.QUICK_REPLIES, directories);

    if (!quickRepliesDirectory || !fs.existsSync(quickRepliesDirectory)) {
        return true;
    }

    let clean = true;
    const markError = () => {
        clean = false;
    };

    for (const managedQuickReply of MANAGED_BUNDLED_QUICK_REPLIES) {
        const bundledPath = path.join(contentDirectory, managedQuickReply.bundledPath);
        let bundledContent;

        try {
            bundledContent = fs.readFileSync(bundledPath);
        } catch (error) {
            clean = false;
            console.warn(`Failed to read bundled quick reply ${managedQuickReply.bundledPath}`, error);
            continue;
        }

        const currentHash = getSha256(bundledContent);
        const staleHashes = new Set(managedQuickReply.staleHashes);
        const currentMatches = [];
        const staleMatches = [];

        for (const filePath of getJsonFilesRecursive(quickRepliesDirectory, markError)) {
            try {
                const fileHash = getSha256(fs.readFileSync(filePath));

                if (fileHash === currentHash) {
                    currentMatches.push(filePath);
                } else if (staleHashes.has(fileHash)) {
                    staleMatches.push(filePath);
                }
            } catch (error) {
                clean = false;
                console.warn(`Failed to inspect quick reply file ${filePath}`, error);
            }
        }

        if (currentMatches.length === 0 && staleMatches.length === 0) {
            continue;
        }

        for (const filePath of staleMatches) {
            try {
                fs.rmSync(filePath, { force: true });
                console.info(`Stale bundled quick reply removed from ${filePath}`);
            } catch (error) {
                clean = false;
                console.warn(`Failed to remove stale bundled quick reply ${filePath}`, error);
            }
        }

        const bundledName = path.parse(managedQuickReply.bundledPath).name;
        const canonicalPath = path.join(quickRepliesDirectory, `${sanitize(bundledName)}.json`);

        if (currentMatches.length >= 2) {
            const keepPath = currentMatches.includes(canonicalPath) ? canonicalPath : currentMatches[0];

            for (const filePath of currentMatches) {
                if (filePath === keepPath) {
                    continue;
                }

                try {
                    fs.rmSync(filePath, { force: true });
                    console.info(`Duplicate bundled quick reply removed from ${filePath}`);
                } catch (error) {
                    clean = false;
                    console.warn(`Failed to remove duplicate bundled quick reply ${filePath}`, error);
                }
            }
        }

        if (currentMatches.length === 0 && staleMatches.length > 0) {
            try {
                fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
                writeFileAtomicSync(canonicalPath, bundledContent);
                setPermissionsSync(canonicalPath);
                console.info(`Bundled quick reply restored to ${canonicalPath}`);
            } catch (error) {
                clean = false;
                console.warn(`Failed to restore bundled quick reply ${canonicalPath}`, error);
            }
        }
    }

    return clean;
}

/**
 * Replaces stale pre-release copies of bundled themes and removes retired ones, without touching user-modified files.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {boolean} True when every inspected theme reconciled without caught errors
 */
export function reconcileManagedBundledThemes(directories) {
    const themesDirectory = getUserTargetByType(CONTENT_TYPES.THEME, directories);

    if (!themesDirectory || !fs.existsSync(themesDirectory)) {
        return true;
    }

    let clean = true;

    for (const retiredTheme of RETIRED_BUNDLED_THEMES) {
        const targetPath = path.join(themesDirectory, retiredTheme.filename);

        try {
            if (!fs.existsSync(targetPath) || !retiredTheme.shippedHashes.includes(getSha256(fs.readFileSync(targetPath)))) {
                continue;
            }

            fs.rmSync(targetPath);
            console.info(`Retired bundled theme removed from ${targetPath}`);
        } catch (error) {
            clean = false;
            console.warn(`Failed to retire bundled theme ${retiredTheme.filename}`, error);
        }
    }

    for (const managedTheme of MANAGED_BUNDLED_THEMES) {
        const targetPath = path.join(themesDirectory, path.parse(managedTheme.bundledPath).base);

        try {
            if (!fs.existsSync(targetPath) || !managedTheme.staleHashes.includes(getSha256(fs.readFileSync(targetPath)))) {
                continue;
            }

            const bundledContent = fs.readFileSync(path.join(contentDirectory, managedTheme.bundledPath));
            writeFileAtomicSync(targetPath, bundledContent);
            setPermissionsSync(targetPath);
            console.info(`Stale bundled theme replaced at ${targetPath}`);
        } catch (error) {
            clean = false;
            console.warn(`Failed to reconcile bundled theme ${managedTheme.bundledPath}`, error);
        }
    }

    return clean;
}

// SillyBunny: digest managed/retired hash rules and user quick-reply/theme stat tuples so unchanged boots skip rehashing while rule or file mutations always reconcile.
const BUNDLED_RECONCILE_RULES_DIGEST = createHash('sha256')
    .update(JSON.stringify({
        quickReplies: MANAGED_BUNDLED_QUICK_REPLIES,
        retiredThemes: RETIRED_BUNDLED_THEMES,
        managedThemes: MANAGED_BUNDLED_THEMES,
    }))
    .digest('hex')
    .slice(0, 16);

function computeBundledContentReconcileSignature(directories) {
    const parts = [`rules:${BUNDLED_RECONCILE_RULES_DIGEST}`];
    const quickRepliesDirectory = getUserTargetByType(CONTENT_TYPES.QUICK_REPLIES, directories);
    for (const managedQuickReply of MANAGED_BUNDLED_QUICK_REPLIES) {
        parts.push(describePathSignature(path.join(contentDirectory, managedQuickReply.bundledPath)));
    }
    if (quickRepliesDirectory && fs.existsSync(quickRepliesDirectory)) {
        const qrFiles = getJsonFilesRecursive(quickRepliesDirectory).sort();
        for (const filePath of qrFiles) {
            const rel = path.relative(quickRepliesDirectory, filePath).split(path.sep).join('/');
            parts.push(`qr:${rel}=${describePathSignature(filePath)}`);
        }
    } else {
        parts.push('qr:absent');
    }

    const themesDirectory = getUserTargetByType(CONTENT_TYPES.THEME, directories);
    if (themesDirectory && fs.existsSync(themesDirectory)) {
        for (const retiredTheme of RETIRED_BUNDLED_THEMES) {
            parts.push(`rt:${retiredTheme.filename}=${describePathSignature(path.join(themesDirectory, retiredTheme.filename))}`);
        }
        for (const managedTheme of MANAGED_BUNDLED_THEMES) {
            const baseName = path.parse(managedTheme.bundledPath).base;
            const userSig = describePathSignature(path.join(themesDirectory, baseName));
            const bundledSig = userSig === 'absent'
                ? 'skip'
                : describePathSignature(path.join(contentDirectory, managedTheme.bundledPath));
            parts.push(`mt:${baseName}=${userSig}:${bundledSig}`);
        }
    } else {
        parts.push('themes:absent');
    }

    return parts.join('|');
}

// SillyBunny: exported, with a managed content directory, so seeding is testable against fixtures.
/**
 * Seeds content for a user.
 * @param {ContentItem[]} contentIndex Content index
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string[]} forceCategories List of categories to force check (even if content check is skipped)
 * @param {object} [options]
 * @param {string} [options.managedDirectory] Where the managed content manifest is; tests point it at fixtures.
 * @param {string} [options.appVersion] Explicit app version override for reconciliation marker checks.
 * @returns {Promise<boolean>} Whether any content was added
 */
export async function seedContentForUser(contentIndex, directories, forceCategories, {
    managedDirectory = contentDirectory,
    appVersion = readAppVersionSignature(),
} = {}) {
    if (!fs.existsSync(directories.root)) {
        fs.mkdirSync(directories.root, { recursive: true });
    }

    const contentLogPath = path.join(directories.root, 'content.log');
    const logState = readContentLogState(contentLogPath);
    removeObsoleteContent(logState.entries, directories);

    // SillyBunny: skip rehashing bundled quick replies and themes when the persisted per-user marker matches.
    const marker = readReconcileMarker(directories.root);
    const beforeContentSig = computeBundledContentReconcileSignature(directories);
    let contentClean = true;
    if (!marker || marker.contentAppVersion !== appVersion || marker.contentSignature !== beforeContentSig) {
        const quickRepliesClean = reconcileManagedBundledQuickReplies(directories);
        const themesClean = reconcileManagedBundledThemes(directories);
        contentClean = quickRepliesClean && themesClean;
        if (contentClean) {
            const afterContentSig = computeBundledContentReconcileSignature(directories);
            writeReconcileMarker(directories.root, {
                appVersion,
                contentAppVersion: appVersion,
                contentSignature: afterContentSig,
            }, setPermissionsSync);
        }
    }

    // SillyBunny: managed content is reconciled per user; a content directory without a manifest manages nothing. A card
    // it replaces loses its cached thumbnails, which the thumbnail route would otherwise keep serving.
    const { clean: managedClean } = reconcileManagedContentWithStatus({
        bundledDirectory: managedDirectory,
        directories,
        appVersion,
        setPermissions: setPermissionsSync,
        invalidateThumbnail: file => invalidateThumbnail(directories, 'avatar', file),
    });

    // SillyBunny: read default-preset-deletions.json once per user pass instead of re-reading per preset.
    const presetDeletions = getDefaultPresetDeletions(directories);
    const filteredContentIndex = contentIndex.filter(contentItem => {
        if (!isPresetContentType(contentItem.type)) {
            return true;
        }

        return !Object.hasOwn(presetDeletions.deleted, getDefaultPresetDeletionKey(contentItem));
    });

    const anyAdded = seedContent(filteredContentIndex, contentLogPath, (type) => getUserTargetByType(type, directories), forceCategories, logState);
    // SillyBunny: refresh the per-user marker after first-boot seeding copies files into place, keeping failed reconcile passes uncached.
    if (anyAdded && (contentClean || managedClean)) {
        const patch = { appVersion };
        if (contentClean) {
            patch.contentAppVersion = appVersion;
            patch.contentSignature = computeBundledContentReconcileSignature(directories);
        }
        if (managedClean) {
            patch.managedAppVersion = appVersion;
            patch.managedSignature = createManagedContent({
                bundledDirectory: managedDirectory,
                directories,
                setPermissions: setPermissionsSync,
                invalidateThumbnail: file => invalidateThumbnail(directories, 'avatar', file),
            }).reconcileSignature();
        }
        writeReconcileMarker(directories.root, patch, setPermissionsSync);
    }
    return anyAdded;
}

/**
 * Seeds global content that is not user-specific, such as error pages.
 * @param {ContentItem[]} contentIndex Content index
 * @returns {Promise<boolean>} Whether any content was added
 */
async function seedGlobalContent(contentIndex) {
    const contentLogPath = path.join(globalThis.DATA_ROOT, 'content.log');
    return seedContent(contentIndex, contentLogPath, getGlobalTargetByType);
}

/**
 * Checks for new content and seeds it for all users.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories
 * @param {string[]} forceCategories List of categories to force check (even if content check is skipped)
 * @returns {Promise<void>}
 */
export async function checkForNewContent(directoriesList, forceCategories = []) {
    try {
        const contentCheckSkip = getConfigValue('skipContentCheck', false, 'boolean');
        if (contentCheckSkip && forceCategories?.length === 0) {
            return;
        }

        const userContentIndex = getContentIndex(CONTENT_SCOPE.USER);
        const globalContentIndex = getContentIndex(CONTENT_SCOPE.GLOBAL);
        let anyContentAdded = false;

        const globalSeedResult = await seedGlobalContent(globalContentIndex);
        if (globalSeedResult) {
            anyContentAdded = true;
        }

        for (const directories of directoriesList) {
            const userSeedResult = await seedContentForUser(userContentIndex, directories, forceCategories);

            if (userSeedResult) {
                anyContentAdded = true;
            }
        }

        if (anyContentAdded && !contentCheckSkip && forceCategories?.length === 0) {
            console.info();
            console.info(`${color.blue('If you don\'t want to receive content updates in the future, set')} ${color.yellow('skipContentCheck')} ${color.blue('to true in the config.yaml file.')}`);
            console.info();
        }
    } catch (err) {
        console.error('Content check failed', err);
    }
}

let cachedContentIndexSignature = null;
/** @type {ContentItem[]} */
let cachedCombinedContentIndex = [];

/**
 * Gets combined content index from the content and scaffold directories.
 * @param {CONTENT_SCOPE} scope Scope of content to get
 * @returns {ContentItem[]} Array of content index
 */
function getContentIndex(scope = CONTENT_SCOPE.USER) {
    // SillyBunny: cache parsed index.json entries keyed by file stat signature.
    const indexSignature = `${describePathSignature(scaffoldIndexPath)}|${describePathSignature(contentIndexPath)}`;
    if (cachedContentIndexSignature !== indexSignature) {
        const combined = [];

        if (fs.existsSync(scaffoldIndexPath)) {
            const scaffoldIndexText = fs.readFileSync(scaffoldIndexPath, 'utf8');
            const scaffoldIndex = JSON.parse(scaffoldIndexText);
            if (Array.isArray(scaffoldIndex)) {
                scaffoldIndex.forEach((item) => {
                    item.folder = scaffoldDirectory;
                    item.scope = getScopeByType(item.type);
                });
                combined.push(...scaffoldIndex);
            }
        }

        if (fs.existsSync(contentIndexPath)) {
            const contentIndexText = fs.readFileSync(contentIndexPath, 'utf8');
            const contentIndex = JSON.parse(contentIndexText);
            if (Array.isArray(contentIndex)) {
                contentIndex.forEach((item) => {
                    item.folder = contentDirectory;
                    item.scope = getScopeByType(item.type);
                });
                combined.push(...contentIndex);
            }
        }

        cachedCombinedContentIndex = combined;
        cachedContentIndexSignature = indexSignature;
    }

    return cachedCombinedContentIndex
        .filter(item => item.scope === scope)
        .map(item => ({ ...item }));
}

/**
 * Gets content by type and format.
 * @param {string} type Type of content
 * @param {'json'|'string'|'raw'} format Format of content
 * @param {CONTENT_SCOPE} scope Scope of content to get
 * @returns {string[]|Buffer[]} Array of content
 */
export function getContentOfType(type, format, scope = CONTENT_SCOPE.USER) {
    const contentIndex = getContentIndex(scope);
    const indexItems = contentIndex.filter((item) => item.type === type && item.folder);
    const files = [];
    for (const item of indexItems) {
        if (!item.folder) {
            continue;
        }
        try {
            const filePath = path.join(item.folder, item.filename);
            if (item.type === CONTENT_TYPES.CHARACTER && path.extname(filePath).toLowerCase() === '.png') {
                recoverFileWriteSync(filePath);
            }
            const fileContent = fs.readFileSync(filePath);
            switch (format) {
                case 'json':
                    files.push(JSON.parse(fileContent.toString()));
                    break;
                case 'string':
                    files.push(fileContent.toString());
                    break;
                case 'raw':
                    files.push(fileContent);
                    break;
            }
        } catch {
            // Ignore errors
        }
    }
    return files;
}

/**
 * Gets the target directory for the specified asset type.
 * @param {ContentType} type Asset type
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string | null} Target directory
 */
export function getUserTargetByType(type, directories) {
    switch (type) {
        case CONTENT_TYPES.SETTINGS:
            return directories.root;
        case CONTENT_TYPES.CHARACTER:
            return directories.characters;
        case CONTENT_TYPES.SPRITES:
            return directories.characters;
        case CONTENT_TYPES.BACKGROUND:
            return directories.backgrounds;
        case CONTENT_TYPES.WORLD:
            return directories.worlds;
        case CONTENT_TYPES.AVATAR:
            return directories.avatars;
        case CONTENT_TYPES.THEME:
            return directories.themes;
        case CONTENT_TYPES.WORKFLOW:
            return directories.comfyWorkflows;
        case CONTENT_TYPES.KOBOLD_PRESET:
            return directories.koboldAI_Settings;
        case CONTENT_TYPES.OPENAI_PRESET:
            return directories.openAI_Settings;
        case CONTENT_TYPES.NOVEL_PRESET:
            return directories.novelAI_Settings;
        case CONTENT_TYPES.TEXTGEN_PRESET:
            return directories.textGen_Settings;
        case CONTENT_TYPES.INSTRUCT:
            return directories.instruct;
        case CONTENT_TYPES.CONTEXT:
            return directories.context;
        case CONTENT_TYPES.MOVING_UI:
            return directories.movingUI;
        case CONTENT_TYPES.QUICK_REPLIES:
            return directories.quickreplies;
        case CONTENT_TYPES.SYSPROMPT:
            return directories.sysprompt;
        case CONTENT_TYPES.REASONING:
            return directories.reasoning;
        default:
            return null;
    }
}

/**
 * Gets the target directory for global content types.
 * @param {CONTENT_TYPES} type Content type
 * @returns {string | null} Target directory
 */
export function getGlobalTargetByType(type) {
    switch (type) {
        case CONTENT_TYPES.ERROR_PAGE:
            return path.join(globalThis.DATA_ROOT, '_errors');
        case CONTENT_TYPES.STYLESHEET:
            return path.join(globalThis.DATA_ROOT, '_css');
        default:
            return null;
    }
}

async function downloadChubLorebook(id) {
    const [lorebooks, creatorName, projectName] = id.split('/');
    const result = await fetch(`https://api.chub.ai/api/${lorebooks}/${creatorName}/${projectName}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Chub returned error', result.statusText, text);
        throw new Error('Failed to fetch lorebook metadata');
    }

    /** @type {any} */
    const metadata = await result.json();
    const projectId = metadata.node?.id;

    if (!projectId) {
        throw new Error('Project ID not found in lorebook metadata');
    }

    const downloadUrl = `https://api.chub.ai/api/v4/projects/${projectId}/repository/files/raw%252Fsillytavern_raw.json/raw`;
    const downloadResult = await fetch(downloadUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!downloadResult.ok) {
        const text = await downloadResult.text();
        console.error('Chub returned error', downloadResult.statusText, text);
        throw new Error('Failed to download lorebook');
    }

    const name = projectName;
    const buffer = Buffer.from(await downloadResult.arrayBuffer());
    const fileName = `${sanitize(name)}.json`;
    const fileType = downloadResult.headers.get('content-type');

    return { buffer, fileName, fileType };
}

/**
 * @param {string} url URL of a Chub character card PNG
 * @param {string} name Base name for the returned file
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string} | null>}
 */
async function tryDownloadChubCharacterCard(url, name) {
    try {
        const downloadResult = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5', 'User-Agent': USER_AGENT },
        });

        if (downloadResult.ok) {
            const buffer = Buffer.from(await downloadResult.arrayBuffer());

            if (isPngBuffer(buffer)) {
                const fileName = `${sanitize(name)}.png`;
                const fileType = 'image/png';

                return { buffer, fileName, fileType };
            }

            console.error('Chub returned non-PNG character card', downloadResult.headers.get('content-type'), url);
        } else {
            const text = await downloadResult.text();
            console.error('Chub returned error', downloadResult.status, downloadResult.statusText, text, url);
        }
    } catch (error) {
        console.error('Failed to download Chub character card', url, getErrorMessage(error));
    }

    return null;
}

async function downloadChubCharacter(id) {
    const [creatorName, projectName] = id.split('/');

    const directCardUrl = `https://avatars.charhub.io/avatars/${[creatorName, projectName].map(encodeURIComponent).join('/')}/chara_card_v2.png`;
    const directCard = await tryDownloadChubCharacterCard(directCardUrl, projectName);
    if (directCard) {
        return directCard;
    }

    const result = await fetch(`https://api.chub.ai/api/characters/${creatorName}/${projectName}?full=true`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Chub returned error', result.status, result.statusText, text);
        throw new Error(`Failed to fetch Chub character metadata: ${result.status} ${result.statusText}`.trim());
    }

    /** @type {any} */
    const metadata = await result.json();
    const node = metadata.node;

    if (!node || typeof node !== 'object') {
        throw new Error('Chub returned invalid character metadata');
    }

    const imageUrl = node?.max_res_url;

    if (imageUrl && imageUrl !== directCardUrl) {
        const card = await tryDownloadChubCharacterCard(imageUrl, node?.name || projectName);
        if (card) {
            return card;
        }
    }

    const { definition, topics } = node;

    if (!definition || typeof definition !== 'object') {
        throw new Error('Chub returned character metadata without definition');
    }

    // Chub does not always include definition.name; fall back to the project/card name.
    const characterName = definition.name || node?.name || projectName;

    /** @type {TavernCardV2} */
    const characterCard = {
        data: {
            name: characterName,
            description: definition.personality,
            personality: definition.tavern_personality,
            scenario: definition.scenario,
            first_mes: definition.first_message,
            mes_example: definition.example_dialogs,
            creator_notes: definition.description,
            system_prompt: definition.system_prompt,
            post_history_instructions: definition.post_history_instructions,
            alternate_greetings: definition.alternate_greetings,
            tags: topics,
            creator: creatorName,
            character_version: '',
            character_book: definition.embedded_lorebook,
            extensions: definition.extensions,
        },
        spec: 'chara_card_v2',
        spec_version: '2.0',
    };

    const defaultAvatarPath = path.join(serverDirectory, DEFAULT_AVATAR_PATH);
    const defaultAvatarBuffer = fs.readFileSync(defaultAvatarPath);

    let imageBuffer = defaultAvatarBuffer;

    const avatarUrl = node?.avatar_url;

    if (avatarUrl) {
        const downloadResult = await fetch(avatarUrl, {
            method: 'GET',
            headers: { 'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5', 'User-Agent': USER_AGENT },
        });
        if (downloadResult.ok) {
            const avatarBuffer = Buffer.from(await downloadResult.arrayBuffer());
            if (isPngBuffer(avatarBuffer)) {
                imageBuffer = avatarBuffer;
            } else {
                console.warn('Chub avatar is not a PNG, using default avatar for fallback card', downloadResult.headers.get('content-type'));
            }
        }
    }

    const buffer = write(imageBuffer, JSON.stringify(characterCard));
    const fileName = `${sanitize(characterCard.data.name)}.png`;
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

// SillyBunny divergence: support Botbooru's SillyTavern import URLs as external character imports.

/**
 * @typedef {Object} BotbooruParsedUrl
 * @property {string} [downloadPath] Path to the PNG download endpoint
 * @property {string} [slug] Botbooru short-link slug
 * @property {string} fallbackName Fallback file name
 * @property {string} [search] Query string to preserve for download URLs
 */

/**
 * @param {string} url Botbooru URL
 * @returns {BotbooruParsedUrl | null} Parsed Botbooru import target
 */
function parseBotbooruUrl(url) {
    try {
        const urlObj = new URL(url);
        const parts = urlObj.pathname.split('/').filter(Boolean);
        const idPattern = /^\d+(?:-\d+)?$/;

        if (parts.length === 3 && parts[0] === 'download' && parts[1] === 'png' && idPattern.test(parts[2])) {
            return {
                downloadPath: `/download/png/${parts[2]}`,
                fallbackName: `botbooru-${parts[2]}`,
                search: urlObj.search,
            };
        }

        if (parts.length === 2 && parts[0] === 'character' && /^\d+$/.test(parts[1])) {
            return {
                downloadPath: `/download/png/${parts[1]}`,
                fallbackName: `botbooru-${parts[1]}`,
            };
        }

        if (parts.length === 3 && parts[0] === 'mini-gallery' && /^\d+$/.test(parts[1]) && parts[2] === 'download.png') {
            return {
                downloadPath: `/mini-gallery/${parts[1]}/download.png`,
                fallbackName: `botbooru-${parts[1]}`,
                search: urlObj.search,
            };
        }

        if (parts.length === 2 && parts[0] === 'q' && parts[1]) {
            return {
                slug: decodeURIComponent(parts[1]),
                fallbackName: `botbooru-${parts[1]}`,
            };
        }
    } catch (error) {
        console.error('Error parsing Botbooru URL:', error);
    }

    return null;
}

/**
 * @param {string} slug Botbooru short-link slug
 * @returns {Promise<BotbooruParsedUrl>} Resolved Botbooru import target
 */
async function resolveBotbooruShortLink(slug) {
    const result = await fetch(`https://botbooru.com/api/q/${encodeURIComponent(slug)}/resolve`, {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Botbooru returned error', result.status, result.statusText, text);
        throw new Error(`Failed to resolve Botbooru short link: ${result.status} ${result.statusText}`.trim());
    }

    /** @type {any} */
    const resolved = await result.json();

    if (resolved.kind === 'lorebook') {
        throw new Error('Botbooru lorebook imports are not supported');
    }

    const postId = resolved.post_id || resolved.post?.id;

    if (!postId) {
        throw new Error('Botbooru short link did not resolve to a character');
    }

    return {
        downloadPath: `/download/png/${encodeURIComponent(String(postId))}`,
        fallbackName: resolved.character_name || resolved.name || `botbooru-${postId}`,
    };
}

/**
 * @param {BotbooruParsedUrl} parsed Parsed Botbooru import target
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadBotbooruCharacter(parsed) {
    const target = parsed.slug ? await resolveBotbooruShortLink(parsed.slug) : parsed;

    if (!target.downloadPath) {
        throw new Error('Botbooru URL did not include a character download path');
    }

    const downloadUrl = new URL(target.downloadPath, 'https://botbooru.com');
    if (target.search) {
        downloadUrl.search = target.search;
    }

    const result = await fetch(downloadUrl, {
        method: 'GET',
        headers: { 'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5', 'User-Agent': USER_AGENT },
    });

    if (!result.ok) {
        const text = await result.text();
        console.error('Botbooru returned error', result.status, result.statusText, text, downloadUrl.toString());
        throw new Error(`Failed to download Botbooru character: ${result.status} ${result.statusText}`.trim());
    }

    const buffer = Buffer.from(await result.arrayBuffer());

    if (!isPngBuffer(buffer)) {
        console.error('Botbooru returned non-PNG character card', result.headers.get('content-type'), downloadUrl.toString());
        throw new Error('Botbooru returned a non-PNG character card');
    }

    const fileName = getPngFileName(getFileNameFromContentDisposition(result.headers.get('content-disposition')), target.fallbackName);
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

/**
 * Downloads a character card from the Pygsite.
 * @param {string} id UUID of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadPygmalionCharacter(id) {
    const result = await fetch(`https://server.pygmalion.chat/api/export/character/${id}/v2`);

    if (!result.ok) {
        const text = await result.text();
        console.error('Pygsite returned error', result.status, text);
        throw new Error('Failed to download character');
    }

    /** @type {any} */
    const jsonData = await result.json();
    const characterData = jsonData?.character;

    if (!characterData || typeof characterData !== 'object') {
        console.error('Pygsite returned invalid character data', jsonData);
        throw new Error('Failed to download character');
    }

    try {
        const avatarUrl = characterData?.data?.avatar;

        if (!avatarUrl) {
            console.error('Pygsite character does not have an avatar', characterData);
            throw new Error('Failed to download avatar');
        }

        const avatarResult = await fetch(avatarUrl);
        const avatarBuffer = Buffer.from(await avatarResult.arrayBuffer());

        const cardBuffer = write(avatarBuffer, JSON.stringify(characterData));

        return {
            buffer: cardBuffer,
            fileName: `${sanitize(id)}.png`,
            fileType: 'image/png',
        };
    } catch (e) {
        console.error('Failed to download avatar, using JSON instead', e);
        return {
            buffer: Buffer.from(JSON.stringify(jsonData)),
            fileName: `${sanitize(id)}.json`,
            fileType: 'application/json',
        };
    }
}

/**
 *
 * @param {String} str
 * @returns { { id: string, type: "character" | "lorebook" } | null }
 */
function parseChubUrl(str) {
    const splitStr = str.split('/');

    let domainIndex = -1;

    splitStr.forEach((part, index) => {
        if (part === 'www.chub.ai' || part === 'chub.ai' || part === 'www.characterhub.org' || part === 'characterhub.org') {
            domainIndex = index;
        }
    });

    const cleanUrl = domainIndex !== -1 ? splitStr.slice(domainIndex + 1) : splitStr;
    const length = cleanUrl.length;

    if (length < 2) {
        return null;
    }

    const firstPart = cleanUrl[0].toLowerCase();

    if (firstPart === 'characters' || firstPart === 'lorebooks') {
        const type = firstPart === 'characters' ? 'character' : 'lorebook';
        const id = type === 'character' ? cleanUrl.slice(1).join('/') : cleanUrl.join('/');
        return {
            id: id,
            type: type,
        };
    } else if (length === 2) {
        return {
            id: cleanUrl.join('/'),
            type: 'character',
        };
    }

    return null;
}

// Warning: Some characters might not exist in JannyAI.me
async function downloadJannyCharacter(uuid) {
    // This endpoint is being guarded behind Bot Fight Mode of Cloudflare
    // So hosted ST on Azure/AWS/GCP/Collab might get blocked by IP
    // Should work normally on self-host PC/Android
    const result = await fetch('https://api.jannyai.com/api/v1/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            'characterId': uuid,
        }),
    });

    if (result.ok) {
        /** @type {any} */
        const downloadResult = await result.json();
        if (downloadResult.status === 'ok') {
            const imageResult = await fetch(downloadResult.downloadUrl);
            const buffer = Buffer.from(await imageResult.arrayBuffer());
            const fileName = `${sanitize(uuid)}.png`;
            const fileType = imageResult.headers.get('content-type');

            return { buffer, fileName, fileType };
        } else {
            console.error('Janny failed to download', downloadResult);
        }
    } else {
        console.error('Janny returned error', result.statusText, await result.text());
    }

    throw new Error('Failed to download character');
}

//Download Character Cards from AICharactersCards.com (AICC) API.
async function downloadAICCCharacter(id) {
    const apiURL = `https://aicharactercards.com/wp-json/pngapi/v1/image/${id}`;
    try {
        const response = await fetch(apiURL);
        if (!response.ok) {
            throw new Error(`Failed to download character: ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || 'image/png'; // Default to 'image/png' if header is missing
        const buffer = Buffer.from(await response.arrayBuffer());
        const fileName = `${sanitize(id)}.png`; // Assuming PNG, but adjust based on actual content or headers

        return {
            buffer: buffer,
            fileName: fileName,
            fileType: contentType,
        };
    } catch (error) {
        console.error('Error downloading character:', error);
        throw error;
    }
}

/**
 * Parses an aicharactercards URL to extract the path.
 * @param {string} url URL to parse
 * @returns {string | null} AICC path
 */
function parseAICC(url) {
    try {
        if (isValidUrl(url)) {
            const urlObj = new URL(url);
            // Split the path and remove empty strings caused by trailing slashes
            const parts = urlObj.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) {
                // Always grab the last two segments (author/character)
                return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
            }
        } else {
            // Fallback for relative paths or raw "author/character" strings
            const parts = url.split('/').filter(Boolean);
            if (parts.length >= 2) {
                return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
            }
        }
    } catch (e) {
        console.error('Error parsing AICC URL:', e);
    }
    return null;
}

/**
 * Download character card from generic url.
 * @param {String} url
 */
async function downloadGenericPng(url) {
    try {
        const result = await fetch(url);

        if (result.ok) {
            const buffer = Buffer.from(await result.arrayBuffer());
            let fileName = sanitize(result.url.split('?')[0].split('/').reverse()[0]);
            const contentType = result.headers.get('content-type') || 'image/png'; //yoink it from AICC function lol

            // The `importCharacter()` function detects the MIME (content-type) of the file
            // using its file extension. The problem is that not all third-party APIs serve
            // their cards with a `.png` extension. To support more third-party sites,
            // dynamically append the `.png` extension to the filename if it doesn't
            // already have a file extension.
            if (contentType === 'image/png') {
                const ext = fileName.match(/\.(\w+)$/); // Same regex used by `importCharacter()`
                if (!ext) {
                    fileName += '.png';
                }
            }

            return {
                buffer: buffer,
                fileName: fileName,
                fileType: contentType,
            };
        }
    } catch (error) {
        console.error('Error downloading file: ', error);
        throw error;
    }
    return null;
}

/**
 * Parse Risu Realm URL to extract the UUID.
 * @param {string} url Risu Realm URL
 * @returns {string | null} UUID of the character
 */
function parseRisuUrl(url) {
    // Example: https://realm.risuai.net/character/7adb0ed8d81855c820b3506980fb40f054ceef010ff0c4bab73730c0ebe92279
    // or https://realm.risuai.net/character/7adb0ed8-d818-55c8-20b3-506980fb40f0
    const pattern = /^https?:\/\/realm\.risuai\.net\/character\/([a-f0-9-]+)\/?$/i;
    const match = url.match(pattern);
    return match ? match[1] : null;
}

/**
 * Download RisuAI character card
 * @param {string} uuid UUID of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string}>}
 */
async function downloadRisuCharacter(uuid) {
    const result = await fetch(`https://realm.risuai.net/api/v1/download/png-v3/${uuid}?non_commercial=true`);

    if (!result.ok) {
        const text = await result.text();
        console.error('RisuAI returned error', result.statusText, text);
        throw new Error('Failed to download character');
    }

    const buffer = Buffer.from(await result.arrayBuffer());
    const fileName = `${sanitize(uuid)}.png`;
    const fileType = 'image/png';

    return { buffer, fileName, fileType };
}

/** * Check if the given string is a valid Perchance UUID.
 * @param {string} uuid UUID string to check
 * @returns {boolean} True if the UUID is valid, false otherwise
 */
function isPerchanceUUID(uuid) {
    if (!uuid) {
        return false;
    }

    //example: Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    //charactername~uuid.gz

    const uuidRegex = /^\w+~[a-f0-9]{32}\.gz$/;
    return uuidRegex.test(uuid);
}

/**
 * Parse Perchance URL to extract the character slug.
 * @param {string} url Perchance character URL
 * @returns {string} Slug of the character
 */
function parsePerchanceSlug(url) {
    // Example: https://perchance.org/ai-character-chat?data=Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    // or: Personality_Advisor~6903e991c90fd1dba52c036d917e99c6.gz
    return url?.split('~')[1] || '';
}

/**
 * Download Perchance character card
 * @param {string} slug Slug of the character
 * @returns {Promise<{buffer: Buffer, fileName: string, fileType: string} | null>}
 */
async function downloadPerchanceCharacter(slug) {
    // example of slug
    // 6903e991c90fd1dba52c036d917e99c6.gz
    const perchanceBaseURL = 'https://user.uploads.dev/file';

    try {
        const charURL = `${perchanceBaseURL}/${slug}`;
        console.log('Downloading Perchance character from URL:', charURL);
        const result = await fetch(charURL, {
            headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        });

        //decompress gzipped content
        if (result.ok) {
            const perchanceChar = await extractPerchanceCharacterFromGz(result);

            const avatarUrl = perchanceChar.avatar?.url;

            //check if avatarURL is a base64 of any image type
            const isAvatarBase64 = avatarUrl && avatarUrl.startsWith('data:image/');

            const charData = {
                name: perchanceChar.name || 'Unnamed Perchance Character',
                first_mes: '',
                tags: [],
                description: perchanceChar.roleInstruction || '',
                creator: perchanceChar.metaTitle || '',
                creator_notes: perchanceChar.metaDescription || '',
                alternate_greetings: [],
                character_version: '',
                mes_example: '',
                post_history_instructions: '',
                system_prompt: '',
                scenario: '',
                personality: perchanceChar.reminderMessage || '',
                extensions: {
                    perchance_data: {
                        slug: slug,
                        char_url: charURL,
                        uuid: perchanceChar.uuid || null,
                        avatar_url: isAvatarBase64 ? null : (avatarUrl || null),
                        folder_path: perchanceChar.folderPath || null,
                        folder_name: perchanceChar.folderName || null,
                        custom_data: perchanceChar.customData || {},
                    },
                },
            };

            const avatarBuffer = await fetchPerchanceAvatar(avatarUrl, isAvatarBase64);

            // Character card
            const buffer = write(avatarBuffer, JSON.stringify({
                'spec': 'chara_card_v2',
                'spec_version': '2.0',
                'data': charData,
            }));

            const fileName = `${charData.name}.png`;
            const fileType = 'image/png';

            return { buffer, fileName, fileType };
        }
    } catch (error) {
        console.error('Error downloading character:', error);
        throw error;
    }
    return null;
}

/**
 * Extracts Perchance character data from a gzipped response.
 * @param {import('node-fetch').Response} result Fetch response containing gzipped character data
 * @returns {Promise<Object>} Parsed Perchance character data
 * @throws {Error} If the character data is invalid or missing required fields
 */
async function extractPerchanceCharacterFromGz(result) {
    const compressedBuffer = await result.arrayBuffer();
    const decompressedBuffer = zlib.gunzipSync(compressedBuffer);

    // inside the gz file, there is a file of the same name without extensions, but it is a json file

    if (!decompressedBuffer || decompressedBuffer.length === 0) {
        console.error('Perchance character data is empty or invalid');
        throw new Error('Failed to download character: Invalid Perchance character data');
    }

    // Parse the decompressed JSON
    const perchanceCharData = JSON.parse(decompressedBuffer.toString());

    if (!perchanceCharData?.addCharacter) {
        console.error('Perchance character data is missing addCharacter field', perchanceCharData);
        throw new Error('Failed to download character: Invalid Perchance character data');
    }

    return perchanceCharData.addCharacter;
}

/** * Fetches the avatar from Perchance URL or uses a default avatar if not available.
 * @param {string} avatarUrl URL of the avatar
 * @param {boolean} isAvatarBase64 Flag indicating if the avatar URL is a base64 string
 * @returns {Promise<Buffer>} Buffer containing the avatar image
 */
async function fetchPerchanceAvatar(avatarUrl, isAvatarBase64) {
    const defaultAvatarPath = path.join(serverDirectory, DEFAULT_AVATAR_PATH);
    const defaultAvatarBuffer = fs.readFileSync(defaultAvatarPath);

    if (!avatarUrl || (!isAvatarBase64 && !isValidUrl(avatarUrl))) {
        console.warn('Perchance character does not have an avatar, it is not base64, or it is an invalid url, using default avatar');
        return defaultAvatarBuffer;
    }

    if (isAvatarBase64) {
        // check if avatarUrl is a png
        const isPng = avatarUrl.startsWith('data:image/png;base64,');
        const base64 = avatarUrl.split(',')[1];
        const buffer = Buffer.from(base64, 'base64');

        if (isPng) {
            return buffer;
        } else {
            // use jimp to convert the base64 to PNG if it's not PNG
            console.debug('Perchance character avatar is not PNG, converting to PNG...');
            return await Jimp.read(buffer).then(image => image.getBuffer(JimpMime.png));
        }
    }

    // Fetch avatar from URL
    console.log('Fetching Perchance avatar from URL:', avatarUrl);
    const avatarResponse = await fetch(avatarUrl, { headers: { 'User-Agent': USER_AGENT } });

    if (avatarResponse.ok) {
        const avatarContentType = avatarResponse.headers.get('content-type');
        const avatarBuffer = Buffer.from(await avatarResponse.arrayBuffer());

        if (avatarContentType === 'image/png') {
            return avatarBuffer;
        } else {
            console.debug(`Perchance character avatar is not PNG: ${avatarContentType}. Converting to PNG...`);

            // use jimp to convert the image to PNG if it's not PNG
            return await Jimp.read(avatarBuffer)
                .then(image => image.getBuffer(JimpMime.png));
        }
    }

    console.error('Failed to fetch Perchance avatar:', avatarResponse.statusText);
    const isPerchanceOrgFileUploader = avatarUrl.includes('https://user-uploads.perchance.org');

    if (isPerchanceOrgFileUploader) {
        console.warn('Files from https://user-uploads.perchance.org are sometimes blocked by CloudFlare, try reuploading it in https://perchance.org/upload to get the new link from https://user-uploads.dev instead.');
    }

    console.warn('You can also download the avatar manually and assign it to the character:', avatarUrl);
    return defaultAvatarBuffer;
}

/**
* @param {String} url
* @returns {String | null } UUID of the character
*/
function getUuidFromUrl(url) {
    // Extract UUID from URL
    const uuidRegex = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/;
    const matches = url.match(uuidRegex);

    // Check if UUID is found
    const uuid = matches ? matches[0] : null;
    return uuid;
}

/**
 * Filter to get the domain host of a url instead of a blanket string search.
 * @param {String} url URL to strip
 * @returns {String} Domain name
 */
export function getHostFromUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname;
    } catch {
        return '';
    }
}

/**
 * Checks if host is part of generic download source whitelist.
 * @param {String} host Host to check
 * @returns {boolean} If the host is on the whitelist.
 */
export function isHostWhitelisted(host) {
    return WHITELIST_GENERIC_URL_DOWNLOAD_SOURCES.includes(host);
}

export const router = express.Router();

router.post('/importURL', async (request, response) => {
    if (!request.body.url) {
        return response.sendStatus(400);
    }

    try {
        const url = request.body.url;
        const host = getHostFromUrl(url);
        let result;
        let type;

        const isChub = host.includes('chub.ai') || host.includes('characterhub.org');
        const isBotbooru = host === 'botbooru.com' || host === 'www.botbooru.com';
        const isJannnyContent = host.includes('janitorai');
        const isPygmalionContent = host.includes('pygmalion.chat');
        const isAICharacterCardsContent = host.includes('aicharactercards.com');
        const isRisu = host.includes('realm.risuai.net');
        const isPerchance = host.includes('perchance.org');
        const isGeneric = isHostWhitelisted(host);

        if (isPygmalionContent) {
            const uuid = getUuidFromUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadPygmalionCharacter(uuid);
        } else if (isJannnyContent) {
            const uuid = getUuidFromUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadJannyCharacter(uuid);
        } else if (isAICharacterCardsContent) {
            const AICCParsed = parseAICC(url);
            if (!AICCParsed) {
                return response.sendStatus(404);
            }
            type = 'character';
            result = await downloadAICCCharacter(AICCParsed);
        } else if (isBotbooru) {
            const botbooruParsed = parseBotbooruUrl(url);
            if (!botbooruParsed) {
                return response.sendStatus(404);
            }

            type = 'character';
            console.info('Downloading Botbooru character:', botbooruParsed.slug || botbooruParsed.downloadPath);
            result = await downloadBotbooruCharacter(botbooruParsed);
        } else if (isChub) {
            const chubParsed = parseChubUrl(url);
            type = chubParsed?.type;

            if (chubParsed?.type === 'character') {
                console.info('Downloading chub character:', chubParsed.id);
                result = await downloadChubCharacter(chubParsed.id);
            } else if (chubParsed?.type === 'lorebook') {
                console.info('Downloading chub lorebook:', chubParsed.id);
                result = await downloadChubLorebook(chubParsed.id);
            } else {
                return response.sendStatus(404);
            }
        } else if (isRisu) {
            const uuid = parseRisuUrl(url);
            if (!uuid) {
                return response.sendStatus(404);
            }

            type = 'character';
            result = await downloadRisuCharacter(uuid);
        } else if (isPerchance) {
            const perchanceSlug = parsePerchanceSlug(url);
            if (!perchanceSlug) {
                return response.sendStatus(404);
            }
            type = 'character';
            result = await downloadPerchanceCharacter(perchanceSlug);
        } else if (isGeneric) {
            console.info('Downloading from generic url:', url);
            type = 'character';
            result = await downloadGenericPng(url);
        } else {
            console.error(`Received an import for "${getHostFromUrl(url)}", but site is not whitelisted. This domain must be added to the config key "whitelistImportDomains" to allow import from this source.`);
            return response.sendStatus(404);
        }

        if (!result) {
            return response.sendStatus(404);
        }

        if (result.fileType) response.set('Content-Type', result.fileType);
        response.set('Content-Disposition', `attachment; filename="${encodeURI(result.fileName)}"`);
        response.set('X-Custom-Content-Type', type);
        return response.send(result.buffer);
    } catch (error) {
        console.error('Importing custom content failed', error);
        return response.status(500).type('text/plain').send(getErrorMessage(error));
    }
});

router.post('/importUUID', async (request, response) => {
    if (!request.body.url) {
        return response.sendStatus(400);
    }

    try {
        const uuid = request.body.url;
        let result;

        const isJannny = uuid.includes('_character');
        const isPygmalion = (!isJannny && uuid.length == 36);
        const isAICC = uuid.startsWith('AICC/');
        const isPerchance = isPerchanceUUID(uuid);
        const uuidType = uuid.includes('lorebook') ? 'lorebook' : 'character';

        if (isPygmalion) {
            console.info('Downloading Pygmalion character:', uuid);
            result = await downloadPygmalionCharacter(uuid);
        } else if (isJannny) {
            console.info('Downloading Janitor character:', uuid.split('_')[0]);
            result = await downloadJannyCharacter(uuid.split('_')[0]);
        } else if (isAICC) {
            const [, author, card] = uuid.split('/');
            console.info('Downloading AICC character:', `${author}/${card}`);
            result = await downloadAICCCharacter(`${author}/${card}`);
        } else if (isPerchance) {
            console.info('Downloading Perchance character:', uuid);
            const parsedUuid = parsePerchanceSlug(uuid);
            result = await downloadPerchanceCharacter(parsedUuid);
        } else {
            if (uuidType === 'character') {
                console.info('Downloading chub character:', uuid);
                result = await downloadChubCharacter(uuid);
            } else if (uuidType === 'lorebook') {
                console.info('Downloading chub lorebook:', uuid);
                result = await downloadChubLorebook(uuid);
            } else {
                return response.sendStatus(404);
            }
        }

        if (!result) {
            throw new Error('Failed to download content');
        }

        if (result.fileType) response.set('Content-Type', result.fileType);
        response.set('Content-Disposition', `attachment; filename="${result.fileName}"`);
        response.set('X-Custom-Content-Type', uuidType);
        return response.send(result.buffer);
    } catch (error) {
        console.error('Importing custom content failed', error);
        return response.sendStatus(500);
    }
});
