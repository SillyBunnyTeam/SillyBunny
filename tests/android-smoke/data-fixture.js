import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_USER = 'default-user';
export const CHARACTER_FILE = 'smoke-fixture.png';
export const CHAT_NAME = 'TODO(copy)';

const CHARACTER_NAME = 'TODO(copy)';
const CREATE_DATE = '2026-01-01@00h00m00s000ms';
const SEND_DATE = 'January 1, 2026 12:00am';

/** PNG chunks need CRC-32; computed here so the helper works on every supported Node version. */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/**
 * Builds a 1x1 transparent PNG character card with a `chara` tEXt chunk (base64 card JSON).
 * The image data is a fixed stored zlib block, so the bytes never depend on the zlib build.
 * @param {object} card Card JSON.
 * @returns {Buffer} PNG bytes.
 */
export function createCharacterCardPng(card) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // RGBA
    // One scanline: filter byte 0 and four zero bytes, as a stored deflate block with its Adler-32.
    const imageData = Buffer.from([0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0, 0, 0, 0, 0, 0x00, 0x05, 0x00, 0x01]);
    const text = Buffer.concat([
        Buffer.from('chara\0', 'latin1'),
        Buffer.from(Buffer.from(JSON.stringify(card), 'utf8').toString('base64'), 'latin1'),
    ]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', imageData),
        pngChunk('tEXt', text),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/** The character card stored in the seeded PNG. */
export function fixtureCharacterCard() {
    const data = {
        name: CHARACTER_NAME,
        description: 'TODO(copy)',
        personality: '',
        scenario: '',
        first_mes: 'TODO(copy)',
        mes_example: '',
        creator_notes: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: [],
        creator: '',
        character_version: '',
        extensions: {},
    };
    return {
        name: data.name,
        description: data.description,
        personality: data.personality,
        scenario: data.scenario,
        first_mes: data.first_mes,
        mes_example: data.mes_example,
        creatorcomment: '',
        avatar: 'none',
        chat: CHAT_NAME,
        talkativeness: '0.5',
        fav: false,
        tags: [],
        create_date: CREATE_DATE,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data,
    };
}

/**
 * The seeded files, relative to the data root, with their exact contents.
 * @param {string} [user] User directory name.
 * @returns {Record<string, Buffer>} Files.
 */
export function dataFixtureFiles(user = DATA_USER) {
    const characterId = path.posix.basename(CHARACTER_FILE, '.png');
    const chat = [
        { user_name: 'User', character_name: CHARACTER_NAME, create_date: CREATE_DATE, chat_metadata: {} },
        { name: CHARACTER_NAME, is_user: false, is_system: false, send_date: SEND_DATE, mes: 'TODO(copy)', extra: {} },
        { name: 'User', is_user: true, is_system: false, send_date: SEND_DATE, mes: 'TODO(copy)', extra: {} },
    ].map(line => JSON.stringify(line)).join('\n');
    // The current secrets format (arrays plus _migrated), so the server has nothing to migrate.
    const secrets = {
        _migrated: [],
        api_key_openai: [{
            id: '00000000-0000-4000-8000-000000000001',
            value: 'sk-sillybunny-smoke-fixture',
            label: 'TODO(copy)',
            active: true,
        }],
    };
    return {
        [`${user}/characters/${CHARACTER_FILE}`]: createCharacterCardPng(fixtureCharacterCard()),
        [`${user}/chats/${characterId}/${CHAT_NAME}.jsonl`]: Buffer.from(`${chat}\n`, 'utf8'),
        [`${user}/secrets.json`]: Buffer.from(JSON.stringify(secrets, null, 4), 'utf8'),
    };
}

/**
 * Writes the data fixture (one character, one chat, secrets.json) under a SillyBunny data root.
 * Existing seeded files are overwritten; nothing else is touched.
 * @param {string} dataRoot The `data/` directory.
 * @param {object} [options] Options.
 * @param {string} [options.user] User directory name.
 * @returns {Promise<{files: string[], manifest: object}>} Seeded paths and their checksum manifest.
 */
export async function seedDataFixture(dataRoot, { user = DATA_USER } = {}) {
    const files = dataFixtureFiles(user);
    for (const [relative, contents] of Object.entries(files)) {
        const target = path.join(dataRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    const paths = Object.keys(files).sort();
    return { files: paths, manifest: await checksumTree(dataRoot, { include: paths }) };
}

function digestEntries(files) {
    const hash = createHash('sha256');
    for (const [file, entry] of Object.entries(files)) {
        hash.update(`${entry.type} ${entry.sha256} ${entry.size} ${file}\n`);
    }
    return hash.digest('hex');
}

async function hashRegularFile(file) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(file)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { type: 'file', sha256: hash.digest('hex'), size };
}

/**
 * Computes a stable checksum manifest of a directory tree: POSIX relative paths in sorted order,
 * content SHA-256 and size per file (timestamps and permissions are ignored), and one digest over
 * all entries. Symbolic links are recorded by target, never followed.
 * @param {string} root Directory.
 * @param {object} [options] Options.
 * @param {string[]} [options.include] Only these relative paths (missing ones are left out).
 * @param {string[]} [options.exclude] Relative path prefixes to skip.
 * @returns {Promise<{schema: number, algorithm: string, files: Record<string, {type: string, sha256: string, size: number}>, digest: string}>} Manifest.
 */
export async function checksumTree(root, { include, exclude = [] } = {}) {
    const found = [];
    const walk = (directory, prefix) => {
        let entries = [];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT' && prefix === '') {
                return;
            }
            throw error;
        }
        for (const entry of entries) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (exclude.some(item => relative === item || relative.startsWith(`${item.replace(/\/+$/, '')}/`))) {
                continue;
            }
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(absolute, relative);
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                found.push({ relative, absolute, link: entry.isSymbolicLink() });
            }
        }
    };
    if (include) {
        for (const relative of include) {
            const absolute = path.join(root, ...relative.split('/'));
            try {
                const stat = fs.lstatSync(absolute);
                if (stat.isFile() || stat.isSymbolicLink()) {
                    found.push({ relative, absolute, link: stat.isSymbolicLink() });
                }
            } catch {
                // Missing paths are absent from the manifest and show up as removed.
            }
        }
    } else {
        walk(root, '');
    }

    found.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
    /** @type {Record<string, {type: string, sha256: string, size: number}>} */
    const files = {};
    for (const item of found) {
        if (item.link) {
            const target = Buffer.from(fs.readlinkSync(item.absolute), 'utf8');
            files[item.relative] = { type: 'symlink', sha256: createHash('sha256').update(target).digest('hex'), size: target.length };
        } else {
            files[item.relative] = await hashRegularFile(item.absolute);
        }
    }
    return { schema: 1, algorithm: 'sha256', files, digest: digestEntries(files) };
}

/**
 * Compares a later manifest with a baseline. Changed or removed baseline files always fail; added
 * files pass unless `allowAdded` refuses them.
 * @param {{files: Record<string, {type: string, sha256: string, size: number}>}} baseline Baseline manifest.
 * @param {{files: Record<string, {type: string, sha256: string, size: number}>}} current Current manifest.
 * @param {object} [options] Options.
 * @param {string[]|((file: string) => boolean)} [options.allowAdded] Allowed path prefixes or a predicate (default: all).
 * @returns {{ok: boolean, changed: string[], removed: string[], added: string[], unexpected: string[]}} Comparison.
 */
export function compareChecksums(baseline, current, { allowAdded = () => true } = {}) {
    const allowed = typeof allowAdded === 'function'
        ? allowAdded
        : (file) => allowAdded.some(prefix => file === prefix || file.startsWith(`${prefix.replace(/\/+$/, '')}/`));
    const changed = [];
    const removed = [];
    for (const [file, entry] of Object.entries(baseline.files)) {
        const other = current.files[file];
        if (!other) {
            removed.push(file);
        } else if (other.type !== entry.type || other.sha256 !== entry.sha256 || other.size !== entry.size) {
            changed.push(file);
        }
    }
    const added = Object.keys(current.files).filter(file => !Object.hasOwn(baseline.files, file));
    const unexpected = added.filter(file => !allowed(file));
    return { ok: changed.length === 0 && removed.length === 0 && unexpected.length === 0, changed, removed, added, unexpected };
}
