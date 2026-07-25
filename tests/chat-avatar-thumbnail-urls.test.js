import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(repoRoot, 'public');
const scriptSource = fs.readFileSync(path.join(publicRoot, 'script.js'), 'utf8');
const tabsSource = fs.readFileSync(path.join(publicRoot, 'scripts', 'sillybunny-tabs.js'), 'utf8');

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

function getFunctionSource(source, name) {
    const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    expect(match).not.toBeNull();
    return match[0];
}

/**
 * Rebuilds the avatar URL pipeline that updateChatAvatarVariables runs in the browser, using the
 * shipped function bodies. Neither module can be imported under Jest, so the sources are evaluated
 * with the handful of globals they close over.
 * @returns {{ getThumbnailUrl: Function, parseAvatarSource: Function, getAvatarRenderSources: Function, getChatAvatarSources: Function }}
 */
function loadAvatarPipeline() {
    const body = [
        getFunctionSource(scriptSource, 'getThumbnailUrl'),
        getFunctionSource(scriptSource, 'getMobileThumbnailUrl'),
        getFunctionSource(scriptSource, 'getFullAvatarUrl'),
        getFunctionSource(scriptSource, 'getAvatarRenderSources'),
        getFunctionSource(scriptSource, 'parseAvatarSource'),
        getFunctionSource(tabsSource, 'stripAvatarOrigin'),
        getFunctionSource(tabsSource, 'isAbsoluteAvatarUrl'),
        getFunctionSource(tabsSource, 'ensureAvatarPath'),
        getFunctionSource(tabsSource, 'getChatAvatarSources'),
        'return { getThumbnailUrl, parseAvatarSource, getAvatarRenderSources, getChatAvatarSources };',
    ].join('\n\n');

    const factory = new Function('window', 'isDataURL', 'default_avatar', body);

    return factory(
        { location: { origin: 'http://localhost:8000' } },
        value => String(value).startsWith('data:'),
        '/img/ai4.png',
    );
}

describe('chat avatar thumbnail urls', () => {
    test('only script.js builds thumbnail endpoint urls', () => {
        const builders = listPublicScripts()
            .filter(file => fs.readFileSync(file, 'utf8').includes('/thumbnail?type='))
            .map(file => path.relative(repoRoot, file));

        expect(builders).toEqual([path.join('public', 'script.js')]);
    });

    test('sillybunny-tabs.js reuses the shared parser instead of a local copy', () => {
        expect(tabsSource).toContain('parseAvatarSource,');
        expect(tabsSource).toContain('getThumbnailUrl,');
        expect(tabsSource).toMatch(/import \{[^}]*parseAvatarSource[^}]*\} from '\.\.\/script\.js';/);
        expect(tabsSource).not.toContain('function parseChatAvatarSource');
        expect(tabsSource).not.toContain('function safeDecodeUriComponent');
    });

    test('script.js decodes the pathname before stripping the avatar folder prefix', () => {
        expect(scriptSource).toContain('export function parseAvatarSource');
        expect(getFunctionSource(scriptSource, 'parseAvatarSource'))
            .toContain('const pathName = decodeURIComponent(parsed.pathname);');
    });

    test('decodes a spaced character path exactly once', () => {
        const { parseAvatarSource } = loadAvatarPipeline();

        expect(parseAvatarSource('/characters/Mara%20Rodriguez.png')).toEqual({
            type: 'avatar',
            file: 'Mara Rodriguez.png',
            original: '/characters/Mara%20Rodriguez.png',
        });
    });

    test('builds a single-encoded thumbnail url for a spaced character avatar', () => {
        const { getChatAvatarSources } = loadAvatarPipeline();

        const { thumb } = getChatAvatarSources('/characters/Mara%20Rodriguez.png');

        expect(thumb).toBe('/thumbnail?type=avatar&file=Mara%20Rodriguez.png');
        expect(thumb).not.toContain('%2520');
    });

    test('recognises a spaced persona path as a persona avatar', () => {
        const { getChatAvatarSources, parseAvatarSource } = loadAvatarPipeline();

        expect(parseAvatarSource('/User%20Avatars/Me%20Myself.png').type).toBe('persona');
        expect(getChatAvatarSources('/User%20Avatars/Me%20Myself.png').thumb)
            .toBe('/thumbnail?type=persona&file=Me%20Myself.png');
    });

    test('is idempotent when a thumbnail url is fed back through the pipeline', () => {
        const { getChatAvatarSources } = loadAvatarPipeline();

        const first = getChatAvatarSources('/characters/Mara%20Rodriguez.png').thumb;
        const second = getChatAvatarSources(first).thumb;

        expect(second).toBe(first);
    });

    test('decodes a thumbnail url file param exactly once', () => {
        const { parseAvatarSource } = loadAvatarPipeline();

        expect(parseAvatarSource('/thumbnail?type=avatar&file=100%2525.png').file).toBe('100%25.png');
    });

    test('leaves sources without a known avatar folder untouched', () => {
        const { getAvatarRenderSources, getChatAvatarSources, parseAvatarSource } = loadAvatarPipeline();

        expect(getChatAvatarSources('').thumb).toBe('');
        expect(getChatAvatarSources('/img/ai4.png').thumb).toBe('/img/ai4.png');
        expect(getChatAvatarSources('data:image/png;base64,AAAA').thumb).toBe('data:image/png;base64,AAAA');
        expect(parseAvatarSource('https://example.test/characters/Remote.png').type).toBeNull();
        expect(getAvatarRenderSources('https://example.test/characters/Remote.png')).toEqual({
            desktop: 'https://example.test/characters/Remote.png',
            mobile: 'https://example.test/characters/Remote.png',
            original: 'https://example.test/characters/Remote.png',
        });
    });

    test('derives desktop, mobile, and original sources for forced local avatars', () => {
        const { getAvatarRenderSources } = loadAvatarPipeline();

        expect(getAvatarRenderSources('/characters/Group%20Member.gif')).toEqual({
            desktop: '/thumbnail?type=avatar&file=Group%20Member.gif',
            mobile: '/thumbnail?type=avatar&file=Group%20Member.gif&preset=mobile',
            original: '/characters/Group%20Member.gif',
        });
        expect(getAvatarRenderSources('/thumbnail?type=persona&file=Me%20Myself.png')).toEqual({
            desktop: '/thumbnail?type=persona&file=Me%20Myself.png',
            mobile: '/thumbnail?type=persona&file=Me%20Myself.png&preset=mobile',
            original: '/User%20Avatars/Me%20Myself.png',
        });
        expect(getAvatarRenderSources('data:image/png;base64,AAAA').mobile).toBe('data:image/png;base64,AAAA');
    });

    test('keeps literal percent persona names decoded exactly once for zoom lookup', () => {
        const { parseAvatarSource } = loadAvatarPipeline();

        expect(parseAvatarSource('/User%20Avatars/50%25%20Off.png').file).toBe('50% Off.png');
        expect(scriptSource).toContain('const isValidPersona = targetAvatarImg in power_user.personas;');
        expect(scriptSource).not.toContain('decodeURIComponent(targetAvatarImg) in power_user.personas');
    });
});
