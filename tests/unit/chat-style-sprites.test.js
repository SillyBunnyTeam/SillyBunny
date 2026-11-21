import {
    buildValidSprites,
    getFolderKey,
    isSpriteEligibleMessage,
    pickSprite,
    resolveMessageFolder,
} from '../../public/scripts/extensions/expressions/chat-style-sprites.js';

const LABELS = ['neutral', 'joy', 'anger', 'custom-wink'];

/** @param {string} label @param {string[]} srcs */
const group = (label, ...srcs) => ({ label, files: srcs.map(imageSrc => ({ imageSrc })) });

describe('chat style sprites', () => {
    describe('getFolderKey', () => {
        test('takes the first path segment', () => {
            expect(getFolderKey('Seraphina/casual')).toBe('Seraphina');
            expect(getFolderKey('Seraphina')).toBe('Seraphina');
            expect(getFolderKey(undefined)).toBe('');
        });
    });

    describe('isSpriteEligibleMessage', () => {
        test('accepts a character message', () => {
            expect(isSpriteEligibleMessage({ name: 'A', is_user: false })).toBe(true);
        });

        test('rejects user, system and narrator messages', () => {
            expect(isSpriteEligibleMessage({ is_user: true })).toBe(false);
            expect(isSpriteEligibleMessage({ is_system: true })).toBe(false);
            expect(isSpriteEligibleMessage({ is_user: false, extra: { type: 'narrator' } })).toBe(false);
            expect(isSpriteEligibleMessage(undefined)).toBe(false);
        });
    });

    describe('resolveMessageFolder', () => {
        const host = { getSpriteFolderName: (message, name) => message.override ?? name };

        test('uses the card name in a single-character chat when the folder is the message name', () => {
            expect(resolveMessageFolder({ name: 'Old Name' }, host, { groupId: null, name2: 'Card Name' })).toBe('Card Name');
        });

        test('keeps the own name of a message that was sent as someone else', () => {
            const sentAs = { name: 'Guest', force_avatar: '/thumbnail?type=avatar&file=Guest.png' };
            expect(resolveMessageFolder(sentAs, host, { groupId: null, name2: 'Card Name' })).toBe('Guest');
        });

        test('keeps the folder in a group chat and keeps an override', () => {
            expect(resolveMessageFolder({ name: 'A' }, host, { groupId: 'g', name2: 'B' })).toBe('A');
            expect(resolveMessageFolder({ name: 'A', override: 'pack/casual' }, host, { groupId: null, name2: 'B' })).toBe('pack/casual');
        });
    });

    describe('buildValidSprites', () => {
        test('keeps labels of the list and the first file of each', () => {
            const sprites = buildValidSprites([group('joy', '/c/joy.webp', '/c/joy2.webp'), group('custom-wink', '/c/w.webp')], LABELS);
            expect([...sprites]).toEqual([['joy', '/c/joy.webp'], ['custom-wink', '/c/w.webp']]);
        });

        test('drops a label outside the list', () => {
            expect(buildValidSprites([group('grumpy', '/c/g.webp')], LABELS).size).toBe(0);
        });

        test('never counts the default emoji set or an empty group', () => {
            const sprites = buildValidSprites([group('joy', '/img/default-expressions/joy.png'), group('anger')], LABELS);
            expect(sprites.size).toBe(0);
        });
    });

    describe('pickSprite', () => {
        const sprites = new Map([['neutral', '/n.webp'], ['joy', '/j.webp'], ['anger', '/a.webp']]);

        test('prefers the current expression', () => {
            expect(pickSprite(sprites, 'joy', 'anger')).toEqual({ label: 'joy', src: '/j.webp' });
        });

        test('falls back to the fallback expression, then to neutral', () => {
            expect(pickSprite(sprites, 'fear', 'anger')).toEqual({ label: 'anger', src: '/a.webp' });
            expect(pickSprite(sprites, 'fear', 'sadness')).toEqual({ label: 'neutral', src: '/n.webp' });
        });

        test('treats #reset, unset and option markers as no label', () => {
            expect(pickSprite(sprites, '#reset', null)).toEqual({ label: 'neutral', src: '/n.webp' });
            expect(pickSprite(sprites, undefined, '#none')).toEqual({ label: 'neutral', src: '/n.webp' });
        });

        test('returns null when nothing resolves', () => {
            expect(pickSprite(new Map([['joy', '/j.webp']]), 'fear', 'anger')).toBeNull();
            expect(pickSprite(new Map(), 'joy', 'neutral')).toBeNull();
        });
    });
});
