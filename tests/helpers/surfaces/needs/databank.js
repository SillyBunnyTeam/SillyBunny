/**
 * Two Data Bank attachments: a global one and one for the audit character. The files are uploaded through
 * `/api/files/upload`, as the Data Bank uploads them; the list of attachments is kept in the account settings
 * (`extension_settings.attachments` and `character_attachments`), so the list comes with the settings answer.
 * See `index.js` for the shape of a need module.
 */

import { fixture as character } from './character.js';
import { enableExtensions, extensionSettings, mergeById, sentences } from '../need-kit.js';

const CREATED = Date.UTC(2026, 0, 5, 10, 0, 0);

/** Each attachment has a file name, the text of the file, its URL on the server, and its size. */
const attachments = [
    { key: 'global', name: 'audit-databank-global.txt', text: `Global notes.\n${sentences(6, 1)}\n` },
    { key: 'character', name: 'audit-databank-character.txt', text: `Notes for the audit character.\n${sentences(6, 2)}\n` },
].map(attachment => Object.freeze({
    ...attachment,
    url: `/user/files/${attachment.name}`,
    size: Buffer.byteLength(attachment.text),
}));

export const fixture = Object.freeze({
    global: attachments[0],
    character: attachments[1],
    characterAvatar: character.avatar,
});

const entry = attachment => ({ url: attachment.url, name: attachment.name, size: attachment.size, created: CREATED });

export default {
    requires: ['character'],
    async exists({ post }) {
        const urls = attachments.map(attachment => attachment.url);
        const verified = await (await post('/api/files/verify', { data: { urls } })).json();
        return urls.every(url => verified[url] === true);
    },
    async seed({ post }) {
        for (const attachment of attachments) {
            const response = await (await post('/api/files/upload', { data: { name: attachment.name, data: Buffer.from(attachment.text).toString('base64') } })).json();
            if (response.path !== attachment.url) {
                throw new Error(`The server stored ${attachment.name} at "${response.path}", not at "${attachment.url}".`);
            }
        }
        return `attachments ${attachments.map(attachment => attachment.name).join(', ')}`;
    },
    settings(settings) {
        enableExtensions(settings, ['attachments']);
        const extensions = extensionSettings(settings);
        extensions.attachments = mergeByUrl(extensions.attachments, [entry(fixture.global)]);
        extensions.character_attachments = {
            ...extensions.character_attachments,
            [character.avatar]: mergeByUrl(extensions.character_attachments?.[character.avatar], [entry(fixture.character)]),
        };
        extensions.disabled_attachments ??= [];
    },
};

/** Like `mergeById`, for attachments, which are identified by their URL. */
function mergeByUrl(list, items) {
    return mergeById((Array.isArray(list) ? list : []).map(item => ({ ...item, id: item.url })), items.map(item => ({ ...item, id: item.url })))
        .map(({ id, ...item }) => item);
}
