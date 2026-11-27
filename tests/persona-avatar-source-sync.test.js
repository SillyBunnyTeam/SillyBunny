/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importPersonasModule } from './util/personas-module-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

function getFunctionSource(source, name) {
    const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0].replace(/^export /, '');
}

function createMessageElement({ isUser = true, forceAvatar = false, src = '' } = {}) {
    const mes = document.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('is_user', String(isUser));
    mes.setAttribute('force_avatar', String(forceAvatar));
    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'avatar';
    const img = document.createElement('img');
    if (src) img.setAttribute('src', src);
    avatarWrap.append(img);
    mes.append(avatarWrap);
    document.body.append(mes);
    return { mes, img };
}

function loadTabAvatarHelpers() {
    // Deferred to Batch 6/7 until script.js + sillybunny-tabs.js behavioural harnesses are introduced.
    const body = [
        getFunctionSource(scriptSource, 'getThumbnailUrl'),
        getFunctionSource(scriptSource, 'getFullAvatarUrl'),
        getFunctionSource(scriptSource, 'parseAvatarSource'),
        getFunctionSource(tabsSource, 'stripAvatarOrigin'),
        getFunctionSource(tabsSource, 'isAbsoluteAvatarUrl'),
        getFunctionSource(tabsSource, 'ensureAvatarPath'),
        getFunctionSource(tabsSource, 'getChatAvatarSources'),
        getFunctionSource(tabsSource, 'formatAvatarCssUrl'),
        getFunctionSource(tabsSource, 'updateChatAvatarVariables'),
        'return { getChatAvatarSources, updateChatAvatarVariables };',
    ].join('\n\n');
    const factory = new Function('window', 'isDataURL', 'default_avatar', 'document', 'HTMLElement', 'HTMLImageElement', 'sbState', body);

    return factory(
        { location: { origin: 'http://localhost:8000' } },
        value => String(value).startsWith('data:'),
        '/img/ai4.png',
        document,
        HTMLElement,
        HTMLImageElement,
        { chatAvatars: { sourceCache: new WeakMap() } },
    );
}

afterEach(() => {
    document.body.replaceChildren();
    jest.restoreAllMocks();
});

describe('persona avatar source synchronization', () => {
    test('persona switches atomically update only unforced user message sources', async () => {
        const mobile = { value: true };
        const currentUser = createMessageElement({ isUser: true, forceAvatar: false });
        const forcedUser = createMessageElement({ isUser: true, forceAvatar: true, src: '/forced.png' });
        const character = createMessageElement({ isUser: false, forceAvatar: false, src: '/character.png' });

        const { personas } = await importPersonasModule({
            isMobile: () => mobile.value,
            power_user: {
                personas: { 'First.png': 'First', 'Mobile.png': 'Mobile', 'Desktop.png': 'Desktop' },
                persona_descriptions: {},
            },
            script: {
                getThumbnailUrl: jest.fn((type, file, cacheBust) => `/desktop/${type}/${file}${cacheBust ? '?t=desktop' : ''}`),
                getMobileThumbnailUrl: jest.fn((type, file, cacheBust) => `/mobile/${type}/${file}${cacheBust ? '?t=mobile' : ''}`),
            },
        });
        personas.initUserAvatar('First.png');

        await personas.setUserAvatar('Mobile.png', { toastPersonaNameChange: false });

        expect(currentUser.img.getAttribute('src')).toBe('/mobile/persona/Mobile.png');
        expect(currentUser.img.getAttribute('data-thumbnail-src')).toBe('/mobile/persona/Mobile.png');
        expect(currentUser.img.getAttribute('data-original-src')).toBe('User Avatars/Mobile.png');
        expect(currentUser.mes.style.getPropertyValue('--sb-message-avatar')).toBe('url("/mobile/persona/Mobile.png")');
        expect(currentUser.mes.style.getPropertyValue('--mes-avatar-url')).toBe('url("/mobile/persona/Mobile.png")');
        expect(currentUser.mes.style.getPropertyValue('--mes-avatar-thumb-url')).toBe('url("/mobile/persona/Mobile.png")');
        expect(currentUser.mes.style.getPropertyValue('--mes-avatar-original-url')).toBe('url("User Avatars/Mobile.png")');
        expect(forcedUser.img.getAttribute('src')).toBe('/forced.png');
        expect(character.img.getAttribute('src')).toBe('/character.png');

        mobile.value = false;
        await personas.setUserAvatar('Desktop.png', { toastPersonaNameChange: false });

        expect(currentUser.img.getAttribute('src')).toBe('User Avatars/Desktop.png');
        expect(currentUser.img.getAttribute('data-thumbnail-src')).toBe('/desktop/persona/Desktop.png');
        expect(currentUser.mes.style.getPropertyValue('--mes-avatar-url')).toBe('url("User Avatars/Desktop.png")');
    });

    test('overwrite refresh warms all caches and applies cache-busted message state', async () => {
        const mobile = { value: true };
        const currentUser = createMessageElement({ isUser: true, forceAvatar: false });
        const forcedCurrent = createMessageElement({ isUser: true, forceAvatar: true, src: '/desktop/persona/Current.png' });
        const forcedOther = createMessageElement({ isUser: true, forceAvatar: true, src: '/desktop/persona/Other.png' });

        document.body.insertAdjacentHTML('beforeend', `
            <form id="form_upload_avatar">
                <input id="avatar_upload_overwrite" name="overwrite_name" value="Current.png" />
                <input id="avatar_upload_file" name="avatar" type="file" />
            </form>
        `);

        const fetchCalls = [];
        const fetchMock = jest.fn(async (url) => {
            fetchCalls.push(url);
            if (url === '/api/avatars/upload') {
                return { ok: true, json: async () => ({ path: 'Current.png' }) };
            }
            if (url === '/api/avatars/get') {
                return { ok: true, json: async () => ['Current.png', 'Other.png'] };
            }
            return { ok: true, json: async () => ({}) };
        });

        const { personas, $ } = await importPersonasModule({
            isMobile: () => mobile.value,
            fetch: fetchMock,
            power_user: {
                never_resize_avatars: true,
                personas: { 'Current.png': 'Current', 'Other.png': 'Other' },
                persona_descriptions: {},
            },
            script: {
                getThumbnailUrl: jest.fn((type, file, cacheBust) => `/desktop/${type}/${file}${cacheBust ? '?t=desktop' : ''}`),
                getMobileThumbnailUrl: jest.fn((type, file, cacheBust) => `/mobile/${type}/${file}${cacheBust ? '?t=mobile' : ''}`),
                parseAvatarSource: jest.fn((rawSrc) => {
                    const source = String(rawSrc || '');
                    const thumbnailMatch = source.match(/^\/(?:desktop|mobile)\/persona\/([^?]+)/);
                    const originalMatch = source.match(/^\/User Avatars\/([^?]+)/);
                    const file = thumbnailMatch?.[1] || originalMatch?.[1];
                    return file ? { type: 'persona', file: decodeURIComponent(file) } : null;
                }),
            },
        });
        personas.initUserAvatar('Current.png');
        await personas.initPersonas();

        const fileInput = document.getElementById('avatar_upload_file');
        const avatarFile = new File(['png-bytes'], 'Current.png', { type: 'image/png' });
        Object.defineProperty(fileInput, 'files', { value: [avatarFile], configurable: true });
        fetchCalls.length = 0;

        const changeEvent = $.Event('change', { target: fileInput });
        $(fileInput).trigger(changeEvent);
        for (let i = 0; i < 25; i++) await Promise.resolve();

        expect(fetchCalls.filter(url => !url.startsWith('/api/'))).toEqual([
            '/desktop/persona/Current.png',
            '/mobile/persona/Current.png',
            'User Avatars/Current.png',
        ]);
        expect(currentUser.img.getAttribute('src')).toBe('/mobile/persona/Current.png?t=mobile');
        expect(currentUser.img.getAttribute('data-thumbnail-src')).toBe('/mobile/persona/Current.png?t=mobile');
        expect(currentUser.img.getAttribute('data-original-src')).toMatch(/^User Avatars\/Current\.png\?t=\d+$/);
        expect(forcedCurrent.img.getAttribute('src')).toBe('/mobile/persona/Current.png?t=mobile');
        expect(forcedCurrent.img.getAttribute('data-original-src')).toMatch(/^User Avatars\/Current\.png\?t=\d+$/);
        expect(forcedOther.img.getAttribute('src')).toBe('/desktop/persona/Other.png');
    });

    test('encodes reserved characters in original persona URLs', async () => {
        const { personas } = await importPersonasModule();
        expect(personas.getUserAvatar('50% Off #1.png')).toBe('User Avatars/50%25%20Off%20%231.png');
    });

    test('tab updater preserves a mobile preset as the display and decorative source', () => {
        const { getChatAvatarSources, updateChatAvatarVariables } = loadTabAvatarHelpers();
        const mobileThumbnail = '/thumbnail?type=persona&file=Mobile%20Me.png&preset=mobile&t=123';
        const original = '/User%20Avatars/Mobile%20Me.png?t=123';
        const { mes: message, img: image } = createMessageElement({ src: mobileThumbnail });
        image.setAttribute('data-thumbnail-src', mobileThumbnail);
        image.setAttribute('data-original-src', original);

        expect(getChatAvatarSources(mobileThumbnail)).toMatchObject({
            display: mobileThumbnail,
            thumb: mobileThumbnail,
            original: '/User%20Avatars/Mobile%20Me.png',
        });

        updateChatAvatarVariables(message);

        const mobileCssUrl = `url(${JSON.stringify(mobileThumbnail)})`;
        expect(message.dataset.avatar).toBe(mobileThumbnail);
        expect(message.dataset.avatarThumb).toBe(mobileThumbnail);
        expect(message.dataset.avatarOriginal).toBe(original);
        expect(message.style.getPropertyValue('--sb-message-avatar')).toBe(mobileCssUrl);
        expect(message.style.getPropertyValue('--mes-avatar-url')).toBe(mobileCssUrl);
        expect(message.style.getPropertyValue('--mes-avatar-thumb-url')).toBe(mobileCssUrl);
        expect(message.style.getPropertyValue('--mes-avatar-original-url')).toBe(`url(${JSON.stringify(original)})`);
    });
});
