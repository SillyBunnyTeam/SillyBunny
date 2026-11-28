/** @jest-environment jsdom */
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importScriptModule } from './util/script-harness.js';
import { importTabsModule } from './util/tabs-harness.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(repoRoot, 'public');
const IGNORED_DIRECTORIES = new Set(['lib', 'third-party', 'node_modules']);

function listPublicScripts(directory = publicRoot, found = []) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!IGNORED_DIRECTORIES.has(entry.name)) {
                listPublicScripts(path.join(directory, entry.name), found);
            }
            continue;
        }
        if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
            found.push(path.join(directory, entry.name));
        }
    }

    return found;
}

const MESSAGE_RENDER_DOM = `
    <div id="chat"></div>
    <div id="message_template" hidden>
        <div class="mes">
            <div class="mesAvatarWrapper"><div class="avatar"><img src=""></div></div>
            <div class="mes_block">
                <div class="ch_name"><span class="name_text"></span></div>
                <div class="mes_text"></div>
            </div>
        </div>
    </div>
`;

describe('chat avatar thumbnail urls', () => {
    let realScript;
    let renderedForcedSources;
    let tabsLoaded;

    beforeAll(async () => {
        const mobileState = { value: false };
        const scriptLoaded = await importScriptModule({
            dom: MESSAGE_RENDER_DOM,
            mocks: {
                'scripts/RossAscends-mods.js': base => ({
                    ...base,
                    isMobile: () => mobileState.value,
                }),
            },
        });
        const renderForcedAvatar = (forceAvatar, { isUser = false } = {}) => {
            const readForViewport = mobile => {
                mobileState.value = mobile;
                const chatEl = document.getElementById('chat');
                chatEl.innerHTML = '';
                scriptLoaded.script.chat.length = 0;
                const mes = { name: 'Speaker', is_user: isUser, is_system: false, mes: 'Hi', force_avatar: forceAvatar };
                scriptLoaded.script.chat.push(mes);
                scriptLoaded.script.addOneMessage(mes, { forceId: 0 });
                const img = chatEl.querySelector('.mes .avatar img');
                return {
                    src: img.getAttribute('src'),
                    thumb: img.getAttribute('data-thumbnail-src'),
                    original: img.getAttribute('data-original-src'),
                };
            };
            const desktop = readForViewport(false);
            const mobile = readForViewport(true);
            return {
                desktop: desktop.thumb || desktop.src,
                mobile: mobile.src,
                original: desktop.original,
            };
        };

        renderedForcedSources = {
            remote: renderForcedAvatar('https://example.test/characters/Remote.png'),
            groupMember: renderForcedAvatar('/characters/Group%20Member.gif'),
            personaThumb: renderForcedAvatar('/thumbnail?type=persona&file=Me%20Myself.png', { isUser: true }),
            dataUrl: renderForcedAvatar('data:image/png;base64,AAAA'),
        };
        realScript = {
            getThumbnailUrl: scriptLoaded.script.getThumbnailUrl,
            getMobileThumbnailUrl: scriptLoaded.script.getMobileThumbnailUrl,
            parseAvatarSource: scriptLoaded.script.parseAvatarSource,
        };
        scriptLoaded.cleanup();

        tabsLoaded = await importTabsModule({
            mocks: {
                'script.js': base => ({
                    ...base,
                    getThumbnailUrl: realScript.getThumbnailUrl,
                    parseAvatarSource: realScript.parseAvatarSource,
                }),
            },
        });
    });

    afterAll(() => {
        tabsLoaded?.cleanup();
    });

    function runTabsChatAvatarPipeline(src, { thumbnailAttr = null, originalAttr = null } = {}) {
        const mes = document.createElement('div');
        mes.className = 'mes';
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        const img = document.createElement('img');
        if (src) img.setAttribute('src', src);
        if (thumbnailAttr !== null) img.setAttribute('data-thumbnail-src', thumbnailAttr);
        if (originalAttr !== null) img.setAttribute('data-original-src', originalAttr);
        avatar.append(img);
        mes.append(avatar);
        document.getElementById('chat').append(mes);
        window.updateSillyBunnyChatAvatars(mes);
        const result = {
            display: mes.dataset.avatar ?? '',
            thumb: mes.dataset.avatarThumb ?? '',
            original: mes.dataset.avatarOriginal ?? '',
            cssAvatar: mes.style.getPropertyValue('--sb-message-avatar'),
            cssUrl: mes.style.getPropertyValue('--mes-avatar-url'),
            cssThumb: mes.style.getPropertyValue('--mes-avatar-thumb-url'),
            cssOriginal: mes.style.getPropertyValue('--mes-avatar-original-url'),
        };
        mes.remove();
        return result;
    }

    test('only script.js builds thumbnail endpoint urls', () => {
        const builders = listPublicScripts()
            .filter(file => fs.readFileSync(file, 'utf8').includes('/thumbnail?type='))
            .map(file => path.relative(repoRoot, file));

        expect(builders).toEqual([path.join('public', 'script.js')]);
    });

    test('decodes a spaced character path exactly once', () => {
        expect(realScript.parseAvatarSource('/characters/Mara%20Rodriguez.png')).toEqual({
            type: 'avatar',
            file: 'Mara Rodriguez.png',
            original: '/characters/Mara%20Rodriguez.png',
        });
    });

    test('builds a single-encoded thumbnail url for a spaced character avatar via sillybunny-tabs.js', () => {
        const { thumb } = runTabsChatAvatarPipeline('/characters/Mara%20Rodriguez.png');

        expect(thumb).toBe('/thumbnail?type=avatar&file=Mara%20Rodriguez.png');
        expect(thumb).not.toContain('%2520');
    });

    test('recognises a spaced persona path as a persona avatar', () => {
        expect(realScript.parseAvatarSource('/User%20Avatars/Me%20Myself.png').type).toBe('persona');
        expect(runTabsChatAvatarPipeline('/User%20Avatars/Me%20Myself.png').thumb)
            .toBe('/thumbnail?type=persona&file=Me%20Myself.png');
    });

    test('is idempotent when a thumbnail url is fed back through the tabs pipeline', () => {
        const first = runTabsChatAvatarPipeline('/characters/Mara%20Rodriguez.png').thumb;
        const second = runTabsChatAvatarPipeline(first).thumb;

        expect(second).toBe(first);
    });

    test('decodes a thumbnail url file param exactly once', () => {
        expect(realScript.parseAvatarSource('/thumbnail?type=avatar&file=100%2525.png').file).toBe('100%25.png');
    });

    test('leaves sources without a known avatar folder untouched', () => {
        expect(runTabsChatAvatarPipeline('').thumb).toBe('');
        expect(runTabsChatAvatarPipeline('/img/ai4.png').thumb).toBe('/img/ai4.png');
        expect(runTabsChatAvatarPipeline('data:image/png;base64,AAAA').thumb).toBe('data:image/png;base64,AAAA');
        expect(realScript.parseAvatarSource('https://example.test/characters/Remote.png').type).toBeNull();
        expect(renderedForcedSources.remote).toEqual({
            desktop: 'https://example.test/characters/Remote.png',
            mobile: 'https://example.test/characters/Remote.png',
            original: 'https://example.test/characters/Remote.png',
        });
    });

    test('derives desktop, mobile, and original sources for forced local avatars', () => {
        expect(renderedForcedSources.groupMember).toEqual({
            desktop: '/thumbnail?type=avatar&file=Group%20Member.gif',
            mobile: '/thumbnail?type=avatar&file=Group%20Member.gif&preset=mobile',
            original: '/characters/Group%20Member.gif',
        });
        expect(renderedForcedSources.personaThumb).toEqual({
            desktop: '/thumbnail?type=persona&file=Me%20Myself.png',
            mobile: '/thumbnail?type=persona&file=Me%20Myself.png&preset=mobile',
            original: '/User%20Avatars/Me%20Myself.png',
        });
        expect(renderedForcedSources.dataUrl.mobile).toBe('data:image/png;base64,AAAA');
    });

    test('tab updater preserves a mobile preset as the display and decorative source', () => {
        const mobileThumbnail = '/thumbnail?type=persona&file=Mobile%20Me.png&preset=mobile&t=123';
        const original = '/User%20Avatars/Mobile%20Me.png?t=123';
        const mobileCssUrl = `url(${JSON.stringify(mobileThumbnail)})`;

        const explicit = runTabsChatAvatarPipeline(mobileThumbnail, {
            thumbnailAttr: mobileThumbnail,
            originalAttr: original,
        });
        expect(explicit).toEqual({
            display: mobileThumbnail,
            thumb: mobileThumbnail,
            original,
            cssAvatar: mobileCssUrl,
            cssUrl: mobileCssUrl,
            cssThumb: mobileCssUrl,
            cssOriginal: `url(${JSON.stringify(original)})`,
        });

        // Without explicit data-* attributes, real parseAvatarSource derives original while preserving mobile display/thumb.
        const inferred = runTabsChatAvatarPipeline(mobileThumbnail);
        expect(inferred.display).toBe(mobileThumbnail);
        expect(inferred.thumb).toBe(mobileThumbnail);
        expect(inferred.original).toBe('/User%20Avatars/Mobile%20Me.png');
    });

    test('keeps literal percent persona names decoded exactly once for zoom lookup', () => {
        expect(realScript.parseAvatarSource('/User%20Avatars/50%25%20Off.png').file).toBe('50% Off.png');
    });
});
