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
    test('chat message avatar images are viewport-aware and preserve originals for zoom', () => {
        expect(scriptSource).toContain('const viewportAvatarImg = isMobile() ? mobileAvatarImg : originalAvatarImg;');
        expect(scriptSource).toContain('const viewportThumbnailSrc = isMobile() ? mobileAvatarImg : avatarImg;');

        const avatarImageAttrs = sourceBetween(
            scriptSource,
            'messageElement.find(\'.avatar img\').attr({',
            'messageElement.find(\'.ch_name .name_text\').text(mes.name);',
        );

        expect(avatarImageAttrs).toContain('src: viewportAvatarImg');
        expect(avatarImageAttrs).toContain('\'data-thumbnail-src\': viewportThumbnailSrc');
        expect(avatarImageAttrs).toContain('\'data-original-src\': originalAvatarImg');
        expect(avatarImageAttrs).not.toContain('src: avatarImg');
        expect(avatarImageAttrs).not.toContain('src: originalAvatarImg');

        const zoomClickHandler = sourceBetween(
            scriptSource,
            '$(document).on(\'click\', \'.mes .avatar\', function () {',
            'document.addEventListener(\'click\', function (e) {',
        );

        expect(zoomClickHandler).toContain('avatarImage.attr(\'data-original-src\') || avatarImage.attr(\'src\')');
        expect(zoomClickHandler).toContain('avatarImage.attr(\'data-thumbnail-src\') || avatarImage.attr(\'src\') || fullAvatarURL');
    });

    test('avatar refresh cache busts both desktop and mobile thumbnail sources', () => {
        const refreshSource = sourceBetween(
            scriptSource,
            'export async function refreshCharacterAvatar(avatarKey) {',
            'export function buildAvatarList(',
        );

        expect(refreshSource).toContain('getMobileThumbnailUrl(\'avatar\', avatarKey)');
        expect(refreshSource).toContain('img.getAttribute(\'data-original-src\')');
        expect(refreshSource).toContain('img.setAttribute(\'data-original-src\', cacheBustedFullAvatarUrl);');
        expect(refreshSource).toContain('thumbnailAvatar?.preset === \'mobile\'');
        expect(refreshSource).toContain('img.setAttribute(\'src\', cacheBustedMobileThumbnailUrl);');
        expect(refreshSource).toContain('img.setAttribute(\'src\', cacheBustedThumbnailUrl);');
    });

    test('desktop thumbnail defaults remain high quality', () => {
        expect(defaultConfig.thumbnails.format).toBe('png');
        expect(defaultConfig.thumbnails.quality).toBe(100);
        expect(defaultConfig.thumbnails.dimensions.avatar).toEqual([864, 1280]);
        expect(defaultConfig.thumbnails.dimensions.persona).toEqual([864, 1280]);

        expect(imageMetadataSource).toContain('avatar: Object.freeze([864, 1280])');
        expect(imageMetadataSource).toContain('persona: Object.freeze([864, 1280])');
        expect(serverAdminSource).toContain('format: \'png\'');
        expect(serverAdminSource).toContain('quality: 100');
    });

    test('mobile thumbnail defaults are kept for Android bandwidth/CPU savings', () => {
        expect(defaultConfig.thumbnails.mobile.format).toBe('jpg');
        expect(defaultConfig.thumbnails.mobile.quality).toBeLessThanOrEqual(82);
        expect(defaultConfig.thumbnails.mobile.dimensions.avatar).toEqual([320, 480]);
        expect(defaultConfig.thumbnails.mobile.dimensions.persona).toEqual([320, 480]);

        expect(imageMetadataSource).toContain('avatar: Object.freeze([320, 480])');
        expect(imageMetadataSource).toContain('persona: Object.freeze([320, 480])');
        expect(serverAdminSource).toContain('format: \'jpg\'');
        expect(serverAdminSource).toContain('quality: 82');
        expect(tabsSource).toContain('Mobile preset');
        expect(tabsSource).toContain('Enable the mobile preset to serve smaller JPG thumbnails to phone-sized screens');
    });

    test('client exposes a viewport-aware thumbnail URL helper', () => {
        expect(scriptSource).toContain('export function getMobileThumbnailUrl(type, file, t = false)');
        expect(scriptSource).toContain('export function getThumbnailUrlForViewport(type, file, t = false)');
        expect(scriptSource).toContain('return isMobile() ? getMobileThumbnailUrl(type, file, t) : getThumbnailUrl(type, file, t);');
    });

    test('cached thumbnails report their encoded image type instead of original filename extension', () => {
        expect(thumbnailsSource).toContain('function setCachedThumbnailContentType(response, filePath)');
        expect(thumbnailsSource).toContain('response.type(\'jpg\')');
        expect(thumbnailsSource).toContain('response.type(\'png\')');
        expect(thumbnailsSource).toContain('setCachedThumbnailContentType(response, pathToCachedFile);');
    });
});
