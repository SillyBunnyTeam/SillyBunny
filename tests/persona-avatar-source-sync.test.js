import { describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptSource = fs.readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const personasSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'personas.js'), 'utf8');
const tabsSource = fs.readFileSync(path.join(repoRoot, 'public', 'scripts', 'sillybunny-tabs.js'), 'utf8');

function getFunctionSource(source, name) {
    const match = source.match(new RegExp(`(?:export )?(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0].replace(/^export /, '');
}

class FakeStyle {
    constructor() {
        this.values = new Map();
    }

    setProperty(name, value) {
        this.values.set(name, value);
    }

    getPropertyValue(name) {
        return this.values.get(name) ?? '';
    }
}

class FakeElement {
    constructor(attributes = {}) {
        this.attributes = new Map(Object.entries(attributes));
        this.dataset = {};
        this.style = new FakeStyle();
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }
}

class FakeImage extends FakeElement {
    get currentSrc() {
        return this.getAttribute('src') ?? '';
    }
}

class FakeMessage extends FakeElement {
    constructor(attributes, image = new FakeImage()) {
        super(attributes);
        this.image = image;
    }

    matches(selector) {
        return selector === '.mes';
    }

    querySelector(selector) {
        return selector === '.avatar img' ? this.image : null;
    }
}

function readAttribute(element, name) {
    return element.getAttribute(name);
}

function loadPersonaAvatarHelpers({ mobile, messages, fetchMock = jest.fn(async () => ({})), mastheadMock = jest.fn() }) {
    const body = [
        getFunctionSource(personasSource, 'getPersonaAvatarSources'),
        getFunctionSource(personasSource, 'messageUsesPersonaAvatar'),
        getFunctionSource(personasSource, 'updateMessagePersonaAvatar'),
        getFunctionSource(personasSource, 'reloadUserAvatar'),
        getFunctionSource(personasSource, 'reloadPersonaAvatar'),
        getFunctionSource(personasSource, 'refreshPersonaAvatar'),
        `return {
            getPersonaAvatarSources,
            reloadUserAvatar,
            refreshPersonaAvatar,
            setUserAvatar(value) { user_avatar = value; },
        };`,
    ].join('\n\n');
    const factory = new Function(
        'getThumbnailUrl',
        'getMobileThumbnailUrl',
        'getUserAvatar',
        'parseAvatarSource',
        'isMobile',
        'document',
        'HTMLElement',
        'HTMLImageElement',
        'fetch',
        'updateSelectedPersonaMasthead',
        'initialUserAvatar',
        `let user_avatar = initialUserAvatar;\n${body}`,
    );

    return factory(
        (type, file, cacheBust) => `/desktop/${type}/${file}${cacheBust ? '?t=desktop' : ''}`,
        (type, file, cacheBust) => `/mobile/${type}/${file}${cacheBust ? '?t=mobile' : ''}`,
        file => `/User Avatars/${file}`,
        (rawSrc) => {
            const source = String(rawSrc || '');
            const thumbnailMatch = source.match(/^\/(?:desktop|mobile)\/persona\/([^?]+)/);
            const originalMatch = source.match(/^\/User Avatars\/([^?]+)/);
            const file = thumbnailMatch?.[1] || originalMatch?.[1];
            return file ? { type: 'persona', file: decodeURIComponent(file) } : null;
        },
        () => mobile.value,
        { querySelectorAll: () => messages },
        FakeElement,
        FakeImage,
        fetchMock,
        mastheadMock,
        'First.png',
    );
}

function loadTabAvatarHelpers() {
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
        {},
        FakeElement,
        FakeImage,
        { chatAvatars: { sourceCache: new WeakMap() } },
    );
}

describe('persona avatar source synchronization', () => {
    test('persona switches atomically update only unforced user message sources', () => {
        const mobile = { value: true };
        const currentUser = new FakeMessage({ is_user: 'true', force_avatar: 'false' });
        const forcedUser = new FakeMessage({ is_user: 'true', force_avatar: 'true' }, new FakeImage({ src: '/forced.png' }));
        const character = new FakeMessage({ is_user: 'false', force_avatar: 'false' }, new FakeImage({ src: '/character.png' }));
        const helpers = loadPersonaAvatarHelpers({ mobile, messages: [currentUser, forcedUser, character] });

        helpers.setUserAvatar('Mobile.png');
        helpers.reloadUserAvatar();

        expect(readAttribute(currentUser.image, 'src')).toBe('/mobile/persona/Mobile.png');
        expect(readAttribute(currentUser.image, 'data-thumbnail-src')).toBe('/mobile/persona/Mobile.png');
        expect(readAttribute(currentUser.image, 'data-original-src')).toBe('/User Avatars/Mobile.png');
        expect(currentUser.style.getPropertyValue('--sb-message-avatar')).toBe('url("/mobile/persona/Mobile.png")');
        expect(currentUser.style.getPropertyValue('--mes-avatar-url')).toBe('url("/mobile/persona/Mobile.png")');
        expect(currentUser.style.getPropertyValue('--mes-avatar-thumb-url')).toBe('url("/mobile/persona/Mobile.png")');
        expect(currentUser.style.getPropertyValue('--mes-avatar-original-url')).toBe('url("/User Avatars/Mobile.png")');
        expect(readAttribute(forcedUser.image, 'src')).toBe('/forced.png');
        expect(readAttribute(character.image, 'src')).toBe('/character.png');

        mobile.value = false;
        helpers.setUserAvatar('Desktop.png');
        helpers.reloadUserAvatar();

        expect(readAttribute(currentUser.image, 'src')).toBe('/User Avatars/Desktop.png');
        expect(readAttribute(currentUser.image, 'data-thumbnail-src')).toBe('/desktop/persona/Desktop.png');
        expect(currentUser.style.getPropertyValue('--mes-avatar-url')).toBe('url("/User Avatars/Desktop.png")');
    });

    test('overwrite refresh warms all caches and applies cache-busted message state', async () => {
        const mobile = { value: true };
        const currentUser = new FakeMessage({ is_user: 'true', force_avatar: 'false' });
        const forcedCurrent = new FakeMessage({ is_user: 'true', force_avatar: 'true' }, new FakeImage({ src: '/desktop/persona/Current.png' }));
        const forcedOther = new FakeMessage({ is_user: 'true', force_avatar: 'true' }, new FakeImage({ src: '/desktop/persona/Other.png' }));
        const fetchMock = jest.fn(async () => ({}));
        const mastheadMock = jest.fn();
        const helpers = loadPersonaAvatarHelpers({ mobile, messages: [currentUser, forcedCurrent, forcedOther], fetchMock, mastheadMock });

        helpers.setUserAvatar('Current.png');
        const cacheBusted = helpers.getPersonaAvatarSources('Current.png', true);
        expect(cacheBusted.desktopThumbnail).toContain('?t=desktop');
        expect(cacheBusted.mobileThumbnail).toContain('?t=mobile');
        expect(cacheBusted.original).toMatch(/\/User Avatars\/Current\.png\?t=\d+$/);

        await helpers.refreshPersonaAvatar('Current.png');

        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            '/desktop/persona/Current.png',
            '/mobile/persona/Current.png',
            '/User Avatars/Current.png',
        ]);
        expect(readAttribute(currentUser.image, 'src')).toBe('/mobile/persona/Current.png?t=mobile');
        expect(readAttribute(currentUser.image, 'data-thumbnail-src')).toBe('/mobile/persona/Current.png?t=mobile');
        expect(readAttribute(currentUser.image, 'data-original-src')).toMatch(/\?t=\d+$/);
        expect(readAttribute(forcedCurrent.image, 'src')).toBe('/mobile/persona/Current.png?t=mobile');
        expect(readAttribute(forcedCurrent.image, 'data-original-src')).toMatch(/\?t=\d+$/);
        expect(readAttribute(forcedOther.image, 'src')).toBe('/desktop/persona/Other.png');
        expect(mastheadMock).toHaveBeenCalledWith(true);
    });

    test('encodes reserved characters in original persona URLs', () => {
        const getUserAvatarSource = getFunctionSource(personasSource, 'getUserAvatar');
        const getUserAvatar = new Function('USER_AVATAR_PATH', `${getUserAvatarSource}\nreturn getUserAvatar;`)('/User Avatars/');

        expect(getUserAvatar('50% Off #1.png')).toBe('/User Avatars/50%25%20Off%20%231.png');
    });

    test('tab updater preserves a mobile preset as the display and decorative source', () => {
        const { getChatAvatarSources, updateChatAvatarVariables } = loadTabAvatarHelpers();
        const mobileThumbnail = '/thumbnail?type=persona&file=Mobile%20Me.png&preset=mobile&t=123';
        const original = '/User%20Avatars/Mobile%20Me.png?t=123';
        const image = new FakeImage({
            src: mobileThumbnail,
            'data-thumbnail-src': mobileThumbnail,
            'data-original-src': original,
        });
        const message = new FakeMessage({}, image);

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
