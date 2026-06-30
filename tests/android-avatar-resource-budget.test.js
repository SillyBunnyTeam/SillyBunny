import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const tabsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');
const imageMetadataSource = readFileSync(path.join(repoRoot, 'src', 'endpoints', 'image-metadata.js'), 'utf8');
const serverAdminSource = readFileSync(path.join(repoRoot, 'src', 'endpoints', 'server-admin.js'), 'utf8');
const thumbnailsSource = readFileSync(path.join(repoRoot, 'src', 'endpoints', 'thumbnails.js'), 'utf8');
const defaultConfig = parse(readFileSync(path.join(repoRoot, 'default', 'config.yaml'), 'utf8'));

function sourceBetween(source, start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

describe('Android avatar resource budget', () => {
    test('chat message avatar images load thumbnails while preserving originals for zoom', () => {
        const avatarImageAttrs = sourceBetween(
            scriptSource,
            'messageElement.find(\'.avatar img\').attr({',
            'messageElement.find(\'.ch_name .name_text\').text(mes.name);',
        );

        expect(avatarImageAttrs).toContain('src: avatarImg');
        expect(avatarImageAttrs).toContain('\'data-thumbnail-src\': avatarImg');
        expect(avatarImageAttrs).toContain('\'data-original-src\': originalAvatarImg');
        expect(avatarImageAttrs).not.toContain('src: originalAvatarImg');

        const zoomClickHandler = sourceBetween(
            scriptSource,
            '$(document).on(\'click\', \'.mes .avatar\', function () {',
            'document.addEventListener(\'click\', function (e) {',
        );

        expect(zoomClickHandler).toContain('avatarImage.attr(\'data-original-src\') || avatarImage.attr(\'src\')');
        expect(zoomClickHandler).toContain('avatarImage.attr(\'data-thumbnail-src\') || avatarImage.attr(\'src\') || fullAvatarURL');
    });

    test('avatar refresh cache busts thumbnail and preserved original sources', () => {
        const refreshSource = sourceBetween(
            scriptSource,
            'export async function refreshCharacterAvatar(avatarKey) {',
            'export function buildAvatarList(',
        );

        expect(refreshSource).toContain('img.getAttribute(\'data-original-src\')');
        expect(refreshSource).toContain('img.setAttribute(\'data-original-src\', cacheBustedFullAvatarUrl);');
        expect(refreshSource).toContain('img.setAttribute(\'data-thumbnail-src\', cacheBustedThumbnailUrl);');
    });

    test('default and recommended avatar thumbnails stay mobile-sized', () => {
        expect(defaultConfig.thumbnails.format).toBe('jpg');
        expect(defaultConfig.thumbnails.quality).toBeLessThanOrEqual(82);
        expect(defaultConfig.thumbnails.dimensions.avatar).toEqual([320, 480]);
        expect(defaultConfig.thumbnails.dimensions.persona).toEqual([320, 480]);

        expect(imageMetadataSource).toContain('avatar: Object.freeze([320, 480])');
        expect(imageMetadataSource).toContain('persona: Object.freeze([320, 480])');
        expect(serverAdminSource).toContain('format: \'jpg\'');
        expect(serverAdminSource).toContain('quality: 82');
        expect(tabsSource).toContain('320x480 avatar/persona thumbnails');
    });

    test('cached thumbnails report their encoded image type instead of original filename extension', () => {
        expect(thumbnailsSource).toContain('function setCachedThumbnailContentType(response, filePath)');
        expect(thumbnailsSource).toContain('response.type(\'jpg\')');
        expect(thumbnailsSource).toContain('response.type(\'png\')');
        expect(thumbnailsSource).toContain('setCachedThumbnailContentType(response, pathToCachedFile);');
    });
});
