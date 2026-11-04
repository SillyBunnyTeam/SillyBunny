import { write as writeCard } from '../../src/character-card-parser.js';
import {
    BACKSLASHES,
    DOTS,
    EMPTY,
    ENCODED,
    EVERY_INPUT,
    LONG,
    MULTIPART,
    NUL_BYTE,
    onPosix,
    onWindows,
    RESERVED,
    SEED_PNG,
    SLASHES,
    TRAILING,
    USER_HANDLE,
} from './hostile-file-names-harness.js';

const CHAT_HEADER = { user_name: 'user', character_name: 'seed', create_date: '2026-01-01', chat_metadata: {} };
const CARD_FILE = {
    name: 'upload.png',
    type: 'image/png',
    content: writeCard(SEED_PNG, JSON.stringify({ name: 'imported', spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'imported', first_mes: 'hello', extensions: {} } })),
};
const JSONL_FILE = { name: 'upload.jsonl', type: 'application/octet-stream', content: Buffer.from(`${JSON.stringify(CHAT_HEADER)}\n`) };
const WORLD_BYTES = Buffer.from('{"entries":{}}');
const WORLD_FILE = { name: 'upload.json', type: 'application/json', content: WORLD_BYTES };
// A ZIP archive with no entries is one end of central directory record.
const ZIP_FILE = { name: 'upload.zip', type: 'application/zip', content: Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18)]) };
const HEX_64 = 'a'.repeat(64);

const SEPARATORS = [SLASHES, BACKSLASHES, NUL_BYTE];

function makeRow(method, mount, path, field, options) {
    const title = `${method} ${mount}${path} ${field}${options.variant ? ` (${options.variant})` : ''}`;
    return { method, mount, path, field, transport: method === 'GET' ? 'query' : 'json', title, ...options };
}

const post = (...args) => makeRow('POST', ...args);
const get = (...args) => makeRow('GET', ...args);

/*
 * One row for each input field of a route that takes a file or folder name. checkRow() reads these fields:
 * plain: a valid value that must succeed, which shows that the fixed fields of the row reach the name handling.
 * reject: the statuses that refuse a name. Any input may answer with one of them.
 * sanitized: the inputs that may succeed because the route cleans or ignores the name. Every other input must be refused.
 * serverError: the inputs that may answer 500.
 * writes: the paths inside the user folder that a request may change. Nothing else may change.
 * body: the exact answer of every success.
 *
 * A backslash separates paths only on Windows. The file name validators refuse it there, and on other systems it
 * is a plain character that the route handles as part of the name, so those rows split BACKSLASHES by platform.
 * RESERVED needs no split because Node gives Windows an absolute path in the \\?\ form, which turns off device names.
 */
export const ROUTE_TABLE = [
    post('/api/avatars', '/delete', 'avatar', { plain: 'seed.png', reject: [400, 403], serverError: [EMPTY] }),
    post('/api/avatars', '/upload', 'overwrite_name', { transport: 'multipart', plain: 'plain', reject: [400], sanitized: [onPosix(BACKSLASHES), TRAILING, EMPTY], writes: ['User Avatars'] }),
    post('/api/avatars', '/upload', 'originalname', { transport: 'filename', plain: 'plain.png', reject: [400], sanitized: [SLASHES, BACKSLASHES, RESERVED, TRAILING, LONG, MULTIPART], serverError: [NUL_BYTE], writes: ['User Avatars'] }),

    post('/api/backgrounds', '/delete', 'bg', { plain: 'seed.png', reject: [400, 403], serverError: [EMPTY] }),
    post('/api/backgrounds', '/rename', 'old_bg', { fixed: { new_bg: 'renamed.png' }, plain: 'seed.png', reject: [400], serverError: [RESERVED, DOTS, EMPTY] }),
    post('/api/backgrounds', '/rename', 'new_bg', { fixed: { old_bg: 'seed.png' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], writes: ['backgrounds'] }),
    post('/api/backgrounds', '/upload', 'originalname', { transport: 'filename', plain: 'plain.png', reject: [400], sanitized: [SLASHES, BACKSLASHES, TRAILING, LONG, MULTIPART], serverError: [NUL_BYTE, RESERVED], writes: ['backgrounds', 'image-metadata.json'] }),
    post('/api/backgrounds', '/upload-new', 'originalname', { transport: 'filename', plain: 'plain.png', reject: [400, 409], sanitized: [SLASHES, BACKSLASHES, TRAILING, LONG, MULTIPART], serverError: [NUL_BYTE], writes: ['backgrounds', 'image-metadata.json'] }),

    post('/api/themes', '/save', 'name', { plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, DOTS], serverError: [RESERVED, LONG], writes: ['themes'] }),
    post('/api/themes', '/create', 'name', { plain: 'plain', reject: [400, 409], sanitized: [SEPARATORS, TRAILING, LONG, DOTS], writes: ['themes'] }),
    post('/api/themes', '/delete', 'name', { plain: 'seed', reject: [400, 404], serverError: [RESERVED] }),
    post('/api/quick-replies', '/save', 'name', { plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, DOTS], serverError: [RESERVED, LONG], writes: ['QuickReplies'] }),
    post('/api/quick-replies', '/delete', 'name', { plain: 'seed', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS], serverError: [RESERVED], body: 'OK' }),
    post('/api/moving-ui', '/save', 'name', { plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, DOTS], serverError: [RESERVED, LONG], writes: ['movingUI'] }),

    post('/api/presets', '/save', 'name', { fixed: { preset: {}, apiId: 'openai' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING], serverError: [LONG], writes: ['OpenAI Settings'] }),
    post('/api/presets', '/save', 'apiId', { fixed: { preset: {}, name: 'renamed' }, plain: 'openai', reject: [400] }),
    post('/api/presets', '/delete', 'name', { fixed: { apiId: 'openai' }, plain: 'seed', reject: [400, 404] }),
    post('/api/presets', '/delete', 'apiId', { fixed: { name: 'seed' }, plain: 'openai', reject: [400] }),

    post('/api/images', '/upload', 'filename', { fixed: { image: 'eA==', format: 'png' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS, EMPTY], serverError: [RESERVED], writes: ['user/images'] }),
    post('/api/images', '/upload', 'ch_name', { fixed: { image: 'eA==', format: 'png', filename: 'renamed' }, plain: 'plain', reject: [400], sanitized: EVERY_INPUT, writes: ['user/images'] }),
    post('/api/images', '/list', 'folder', { plain: 'seed', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS], writes: ['user/images'] }),
    post('/api/images', '/list/:folder', 'folder', { transport: 'param', plain: 'seed', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS, ENCODED], writes: ['user/images'] }),
    post('/api/images', '/delete', 'path', { plain: 'user/images/seed/seed.png', reject: [400] }),

    get('/api/sprites', '/get', 'name', { plain: 'seed', reject: [400], sanitized: EVERY_INPUT, body: '[]' }),
    post('/api/sprites', '/delete', 'name', { fixed: { label: 'joy' }, plain: 'seed', reject: [400, 404] }),
    post('/api/sprites', '/delete', 'label', { fixed: { name: 'seed' }, plain: 'joy', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS], body: 'OK' }),
    post('/api/sprites', '/delete', 'spriteName', { fixed: { name: 'seed', label: 'joy' }, plain: 'joy', reject: [400], sanitized: EVERY_INPUT, writes: ['characters'] }),
    post('/api/sprites', '/upload-zip', 'name', { transport: 'multipart', file: ZIP_FILE, plain: 'seed', reject: [400], sanitized: [BACKSLASHES, NUL_BYTE, TRAILING, LONG], writes: ['characters'] }),
    post('/api/sprites', '/upload', 'name', { transport: 'multipart', fixed: { label: 'joy' }, plain: 'seed', reject: [400], sanitized: [BACKSLASHES, NUL_BYTE, TRAILING, LONG], writes: ['characters'] }),
    post('/api/sprites', '/upload', 'label', { transport: 'multipart', fixed: { name: 'seed' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS], serverError: [RESERVED], writes: ['characters'] }),
    post('/api/sprites', '/upload', 'spriteName', { transport: 'multipart', fixed: { name: 'seed', label: 'joy' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS, EMPTY], serverError: [RESERVED], writes: ['characters'] }),
    post('/api/sprites', '/upload', 'originalname', { transport: 'filename', fixed: { name: 'seed', label: 'joy' }, plain: 'plain.png', reject: [400], sanitized: [SLASHES, BACKSLASHES, RESERVED, TRAILING, LONG, MULTIPART], serverError: [NUL_BYTE], writes: ['characters'] }),

    post('/api/characters', '/create', 'file_name', { fixed: { ch_name: 'created' }, plain: 'plain', reject: [400], sanitized: [onPosix(BACKSLASHES), RESERVED, TRAILING, DOTS, EMPTY], serverError: [LONG], writes: ['characters', 'chats', 'entity-date-added.json'] }),
    post('/api/characters', '/rename', 'avatar_url', { fixed: { new_name: 'renamed' }, plain: 'seed.png', reject: [400], serverError: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, DOTS], writes: ['entity-date-added.json'] }),
    post('/api/characters', '/rename', 'new_name', { fixed: { avatar_url: 'seed.png' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, DOTS], serverError: [LONG], writes: ['characters', 'chats', 'entity-date-added.json', 'entity-last-chat.json'] }),
    post('/api/characters', '/edit', 'avatar_url', { fixed: { ch_name: 'edited' }, plain: 'seed.png', reject: [400], serverError: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, DOTS, EMPTY] }),
    post('/api/characters', '/edit-avatar', 'avatar_url', { transport: 'multipart', plain: 'seed.png', reject: [400], serverError: [DOTS] }),
    post('/api/characters', '/edit-attribute', 'avatar_url', { fixed: { ch_name: 'edited', field: 'name', value: 'edited' }, plain: 'seed.png', reject: [400], serverError: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, DOTS, EMPTY] }),
    post('/api/characters', '/merge-attributes', 'avatar', { plain: 'seed.png', reject: [400], serverError: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, DOTS, EMPTY] }),
    post('/api/characters', '/merge-attributes', 'avatars', { wrap: value => ({ avatars: [value], data: { tags: [] } }), plain: 'seed.png', reject: [400] }),
    post('/api/characters', '/last-chat', 'avatar', { fixed: { chat: 'seed' }, plain: 'seed.png', reject: [400], sanitized: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, DOTS], writes: ['entity-last-chat.json'] }),
    post('/api/characters', '/delete', 'avatar_url', { plain: 'seed.png', reject: [400, 403] }),
    post('/api/characters', '/get', 'avatar_url', { plain: 'seed.png', reject: [400, 404], sanitized: [DOTS], serverError: [EMPTY], writes: ['entity-date-added.json'] }),
    post('/api/characters', '/chats', 'avatar_url', { plain: 'seed.png', reject: [400], sanitized: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, DOTS, EMPTY] }),
    post('/api/characters', '/chats', 'file_name', { fixed: { avatar_url: 'seed.png' }, plain: 'seed', reject: [400], sanitized: EVERY_INPUT }),
    post('/api/characters', '/import', 'preserved_name', { transport: 'multipart', fixed: { file_type: 'png' }, file: CARD_FILE, plain: 'plain', reject: [400], sanitized: [SLASHES, BACKSLASHES, onWindows(NUL_BYTE), RESERVED, TRAILING, DOTS, EMPTY], writes: ['characters', 'entity-date-added.json'] }),
    post('/api/characters', '/import', 'originalname', { transport: 'filename', fixed: { file_type: 'png' }, fileContent: CARD_FILE.content, plain: 'plain.png', reject: [400], sanitized: [SLASHES, BACKSLASHES, RESERVED, TRAILING, LONG, MULTIPART], serverError: [NUL_BYTE], writes: ['characters', 'entity-date-added.json'] }),
    post('/api/characters', '/duplicate', 'avatar_url', { plain: 'seed.png', reject: [400, 404], sanitized: [RESERVED, DOTS], body: '{"error":true}' }),
    post('/api/characters', '/export', 'avatar_url', { variant: 'JSON', fixed: { format: 'json' }, plain: 'seed.png', reject: [400, 404] }),
    post('/api/characters', '/export', 'avatar_url', { variant: 'PNG', fixed: { format: 'png' }, plain: 'seed.png', reject: [400, 404], serverError: [RESERVED, DOTS] }),

    post('/api/chats', '/save', 'avatar_url', { fixed: { file_name: 'renamed', chat: [CHAT_HEADER] }, plain: 'seed.png', reject: [400], sanitized: [RESERVED, TRAILING], serverError: [onPosix(BACKSLASHES), LONG, EMPTY, '.'], writes: ['backups', 'chats'] }),
    post('/api/chats', '/save', 'file_name', { fixed: { avatar_url: 'seed.png', chat: [CHAT_HEADER] }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS, EMPTY], serverError: [RESERVED], writes: ['backups', 'chats'] }),
    post('/api/chats', '/get', 'avatar_url', { fixed: { file_name: 'seed' }, plain: 'seed.png', reject: [400, 404, 422], serverError: [onPosix(BACKSLASHES), EMPTY, '.'] }),
    post('/api/chats', '/get', 'file_name', { fixed: { avatar_url: 'seed.png' }, plain: 'seed', reject: [400, 404], sanitized: [EMPTY], serverError: [RESERVED], body: '[]' }),
    post('/api/chats', '/rename', 'avatar_url', { fixed: { original_file: 'seed.jsonl', renamed_file: 'renamed.jsonl' }, plain: 'seed.png', reject: [400], serverError: [LONG], writes: ['chats'] }),
    post('/api/chats', '/rename', 'original_file', { fixed: { avatar_url: 'seed.png', renamed_file: 'renamed.jsonl' }, plain: 'seed.jsonl', reject: [400], serverError: [RESERVED, DOTS] }),
    post('/api/chats', '/rename', 'renamed_file', { fixed: { avatar_url: 'seed.png', original_file: 'seed.jsonl' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], writes: ['backups', 'chats'] }),
    post('/api/chats', '/rename', 'original_file', { variant: 'group chat', fixed: { is_group: true, renamed_file: 'renamed.jsonl' }, plain: 'seedchat.jsonl', reject: [400], serverError: [RESERVED, DOTS] }),
    post('/api/chats', '/rename', 'renamed_file', { variant: 'group chat', fixed: { is_group: true, original_file: 'seedchat.jsonl' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], writes: ['backups', 'group chats'] }),
    post('/api/chats', '/delete', 'avatar_url', { fixed: { chatfile: 'seed.jsonl' }, plain: 'seed.png', reject: [400], serverError: [onPosix(BACKSLASHES), EMPTY, '.'], writes: ['backups'] }),
    post('/api/chats', '/delete', 'chatfile', { fixed: { avatar_url: 'seed.png' }, plain: 'seed.jsonl', reject: [400], serverError: [RESERVED], writes: ['backups'] }),
    post('/api/chats', '/import', 'avatar_url', { transport: 'multipart', fixed: { file_type: 'jsonl', character_name: 'seed', user_name: 'user' }, file: JSONL_FILE, plain: 'seed.png', reject: [400], sanitized: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, EMPTY, '.'], writes: ['chats'] }),
    post('/api/chats', '/import', 'character_name', { transport: 'multipart', fixed: { file_type: 'jsonl', avatar_url: 'seed.png', user_name: 'user' }, file: JSONL_FILE, plain: 'plain', reject: [400], sanitized: EVERY_INPUT, writes: ['chats'] }),
    post('/api/chats', '/import', 'user_name', { transport: 'multipart', fixed: { file_type: 'jsonl', avatar_url: 'seed.png', character_name: 'seed' }, file: JSONL_FILE, plain: 'plain', reject: [400], sanitized: EVERY_INPUT, writes: ['chats'] }),
    post('/api/chats', '/group/get', 'id', { plain: 'seedchat', reject: [400, 404], serverError: [RESERVED] }),
    post('/api/chats', '/group/info', 'id', { plain: 'seedchat', reject: [400, 404], serverError: [RESERVED] }),
    post('/api/chats', '/group/delete', 'id', { plain: 'seedchat', reject: [400], serverError: [RESERVED], writes: ['backups'] }),
    post('/api/chats', '/group/save', 'id', { fixed: { chat: [CHAT_HEADER] }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS], serverError: [RESERVED], writes: ['backups', 'group chats'] }),

    get('/api/chats/archive', '/view', 'token', { fixed: { hash: HEX_64 }, reject: [400] }),
    get('/api/chats/archive', '/view', 'hash', { fixed: { token: HEX_64 }, reject: [400] }),

    post('/api/groups', '/create', 'chat_id', { fixed: { name: 'created' }, plain: 'plain', reject: [400], sanitized: EVERY_INPUT, writes: ['entity-date-added.json', 'group chats', 'groups'] }),
    post('/api/groups', '/edit', 'id', { fixed: { name: 'edited' }, plain: 'seed', reject: [400], sanitized: [onPosix(BACKSLASHES), TRAILING, DOTS], serverError: [RESERVED, LONG], writes: ['entity-date-added.json', 'groups'] }),
    post('/api/groups', '/delete', 'id', { plain: 'seed', reject: [400], serverError: [onPosix(BACKSLASHES), RESERVED, TRAILING, LONG, DOTS] }),

    post('/api/worldinfo', '/get', 'name', { plain: 'seed', reject: [400, 404] }),
    post('/api/worldinfo', '/delete', 'name', { plain: 'seed', reject: [400, 404] }),
    post('/api/worldinfo', '/import', 'name', { transport: 'multipart', file: WORLD_FILE, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], writes: ['worlds'] }),
    post('/api/worldinfo', '/import', 'originalname', { transport: 'filename', fileContent: WORLD_BYTES, plain: 'plain.png', reject: [400], sanitized: [SLASHES, BACKSLASHES, TRAILING, LONG, MULTIPART], serverError: [NUL_BYTE], writes: ['worlds'] }),
    post('/api/worldinfo', '/edit', 'name', { fixed: { data: { entries: {} } }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], writes: ['worlds'] }),
    post('/api/worldinfo', '/rename', 'oldName', { fixed: { newName: 'renamed', data: { entries: {} } }, plain: 'seed', reject: [400] }),
    post('/api/worldinfo', '/rename', 'newName', { fixed: { oldName: 'seed', data: { entries: {} } }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], writes: ['worlds'] }),

    post('/api/assets', '/download', 'filename', { fixed: { url: 'http://localhost:1/x.png', category: 'bgm' }, reject: [400], writes: ['assets'] }),
    post('/api/assets', '/download', 'category', { fixed: { url: 'http://localhost:1/x.png', filename: 'x.png' }, reject: [400] }),
    post('/api/assets', '/delete', 'filename', { fixed: { category: 'bgm' }, plain: 'seed.mp3', reject: [400] }),
    post('/api/assets', '/delete', 'category', { fixed: { filename: 'seed.mp3' }, plain: 'bgm', reject: [400] }),
    post('/api/assets', '/character', 'name', { transport: 'query', fixed: { category: 'bgm' }, plain: 'seed', reject: [400], sanitized: EVERY_INPUT, body: '[]' }),
    post('/api/assets', '/character', 'category', { transport: 'query', fixed: { name: 'seed' }, plain: 'bgm', reject: [400] }),

    post('/api/files', '/upload', 'name', { fixed: { data: 'eA==' }, plain: 'plain.txt', reject: [400] }),
    post('/api/files', '/delete', 'path', { plain: 'user/files/seed.txt', reject: [400] }),
    post('/api/files', '/verify', 'urls', { wrap: value => ({ urls: [value] }), plain: 'user/files/seed.txt', reject: [400], sanitized: EVERY_INPUT, body: '{}' }),

    post('/api/extensions', '/install', 'url', { reject: [400] }),
    post('/api/extensions', '/update', 'extensionName', { reject: [400, 404] }),
    post('/api/extensions', '/branches', 'extensionName', { reject: [400, 404] }),
    post('/api/extensions', '/switch', 'extensionName', { fixed: { branch: 'main' }, reject: [400, 404] }),
    post('/api/extensions', '/move', 'extensionName', { fixed: { source: 'local', destination: 'local' }, reject: [400, 404] }),
    post('/api/extensions', '/move', 'source', { fixed: { extensionName: 'seed', destination: 'local' }, reject: [400, 409] }),
    post('/api/extensions', '/move', 'destination', { fixed: { extensionName: 'seed', source: 'local' }, reject: [400, 409] }),
    post('/api/extensions', '/version', 'extensionName', { plain: 'seed', reject: [400, 404] }),
    post('/api/extensions', '/sync', 'extensionName', { reject: [400] }),
    post('/api/extensions', '/delete', 'extensionName', { plain: 'seed', reject: [400, 404] }),

    post('/api/settings', '/load-snapshot', 'name', { plain: 'settings_default-user_seed.json', reject: [400] }),
    post('/api/settings', '/restore-snapshot', 'name', { plain: 'settings_default-user_seed.json', reject: [400] }),
    post('/api/settings', '/load-snapshot', 'name', { variant: 'inside the pattern', wrap: value => ({ name: `settings_${USER_HANDLE}_${value}` }), plain: 'seed.json', reject: [400, 404] }),
    post('/api/settings', '/restore-snapshot', 'name', { variant: 'inside the pattern', wrap: value => ({ name: `settings_${USER_HANDLE}_${value}` }), plain: 'seed.json', reject: [400, 404] }),

    post('/api/backups', '/chat/delete', 'name', { plain: 'chat_seed.jsonl', reject: [400] }),
    post('/api/backups', '/chat/download', 'name', { plain: 'chat_seed.jsonl', reject: [400] }),
    post('/api/backups', '/chat/delete', 'name', { variant: 'inside the pattern', wrap: value => ({ name: `chat_${value}.jsonl` }), plain: 'seed', reject: [400, 404] }),
    post('/api/backups', '/chat/download', 'name', { variant: 'inside the pattern', wrap: value => ({ name: `chat_${value}.jsonl` }), plain: 'seed', reject: [400, 404] }),

    get('/api/data-maid', '/view', 'token', { fixed: { hash: 'seed-hash' }, plain: 'seed-token', reject: [400, 403] }),
    get('/api/data-maid', '/view', 'hash', { fixed: { token: 'seed-token' }, plain: 'seed-hash', reject: [400, 404] }),
    post('/api/data-maid', '/delete', 'token', { fixed: { hashes: ['seed-hash'] }, plain: 'seed-token', reject: [400, 403] }),
    post('/api/data-maid', '/delete', 'hashes', { wrap: value => ({ token: 'seed-token', hashes: [value] }), plain: 'seed-hash', reject: [400], sanitized: EVERY_INPUT, body: '' }),

    post('/api/image-metadata', '/', 'path', { plain: 'backgrounds/seed.png', reject: [400, 404], serverError: [SLASHES, onWindows(BACKSLASHES), '..'] }),
    post('/api/image-metadata', '/', 'paths', { wrap: value => ({ paths: [value] }), plain: 'backgrounds/seed.png', reject: [400], sanitized: EVERY_INPUT }),

    post('/api/vector', '/purge', 'collectionId', { leftOut: [...RESERVED, ...DOTS], plain: 'seed', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], body: 'OK' }),
    post('/api/vector', '/list', 'collectionId', { fixed: { source: 'webllm', model: 'model' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS], writes: ['vectors'] }),
    post('/api/vector', '/list', 'source', { fixed: { collectionId: 'collection', model: 'model' }, plain: 'webllm', reject: [400], sanitized: EVERY_INPUT, writes: ['vectors'] }),
    post('/api/vector', '/list', 'model', { fixed: { collectionId: 'collection', source: 'webllm' }, plain: 'plain', reject: [400], sanitized: EVERY_INPUT, writes: ['vectors'] }),
    post('/api/vector', '/delete', 'collectionId', { fixed: { source: 'webllm', model: 'model', hashes: [1] }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS], writes: ['vectors'] }),
    post('/api/vector', '/delete', 'source', { fixed: { collectionId: 'collection', model: 'model', hashes: [1] }, plain: 'webllm', reject: [400], sanitized: EVERY_INPUT, writes: ['vectors'] }),
    post('/api/vector', '/insert', 'collectionId', { fixed: { source: 'webllm', model: 'model', items: [] }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS], writes: ['vectors'] }),
    post('/api/vector', '/insert', 'source', { fixed: { collectionId: 'collection', model: 'model', items: [] }, plain: 'webllm', reject: [400], sanitized: EVERY_INPUT, writes: ['vectors'] }),
    post('/api/vector', '/query', 'collectionId', { fixed: { source: 'webllm', model: 'model', searchText: 'q', embeddings: { q: [0.5, 0.5] } }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS], writes: ['vectors'] }),
    post('/api/vector', '/query', 'source', { fixed: { collectionId: 'collection', model: 'model', searchText: 'q', embeddings: { q: [0.5, 0.5] } }, plain: 'webllm', reject: [400], sanitized: [EMPTY], serverError: [SEPARATORS, RESERVED, TRAILING, LONG, DOTS], writes: ['vectors'] }),

    post('/api/in-chat-agents', '/save', 'id', { plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, DOTS], serverError: [RESERVED, LONG], writes: ['InChatAgents'] }),
    post('/api/in-chat-agents', '/delete', 'id', { plain: 'seed', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS], serverError: [RESERVED], body: 'OK' }),
    post('/api/in-chat-agents', '/groups/save', 'id', { plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING, DOTS], serverError: [RESERVED, LONG], writes: ['InChatAgentGroups'] }),
    post('/api/in-chat-agents', '/groups/delete', 'id', { plain: 'seed', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG, DOTS], serverError: [RESERVED], body: 'OK' }),

    post('/api/sd', '/comfy/workflow', 'file_name', { plain: 'seed.json', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], serverError: [RESERVED, DOTS, EMPTY], body: '"{}"' }),
    post('/api/sd', '/comfy/save-workflow', 'file_name', { fixed: { workflow: '{}' }, plain: 'plain', reject: [400], sanitized: [SEPARATORS, TRAILING], serverError: [RESERVED, LONG, DOTS, EMPTY], writes: ['user/workflows'] }),
    post('/api/sd', '/comfy/delete-workflow', 'file_name', { plain: 'seed.json', reject: [400], sanitized: [SEPARATORS, TRAILING, LONG], serverError: [RESERVED, DOTS, EMPTY], body: 'OK' }),
    post('/api/sd', '/comfy/rename-workflow', 'old_name', { fixed: { new_name: 'renamed.json' }, plain: 'seed.json', reject: [400] }),
    post('/api/sd', '/comfy/rename-workflow', 'new_name', { fixed: { old_name: 'seed.json' }, plain: 'plain.json', reject: [400] }),

    get('/thumbnail', '', 'file', { variant: 'avatar', fixed: { type: 'avatar' }, plain: 'seed.png', reject: [400, 403, 404] }),
    get('/thumbnail', '', 'file', { variant: 'bg', fixed: { type: 'bg' }, plain: 'seed.png', reject: [400, 403, 404] }),
    get('/thumbnail', '', 'file', { variant: 'persona', fixed: { type: 'persona' }, plain: 'seed.png', reject: [400, 403, 404] }),
    get('/thumbnail', '', 'type', { fixed: { file: 'seed.png' }, plain: 'avatar', reject: [400] }),

    post('/api/server-admin', '/server-plugins/apply-release', 'directoryName', { fixed: { targetVersion: '1.0.0' }, reject: [400, 409] }),
    post('/api/server-admin', '/server-plugins/apply-release', 'targetVersion', { fixed: { directoryName: 'seed' }, reject: [400, 409] }),
];
