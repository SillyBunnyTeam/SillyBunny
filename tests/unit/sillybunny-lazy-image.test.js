/** @jest-environment jsdom */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { createLazyImage } = await import('../../public/scripts/sillybunny-editor/lazy-image.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/scripts');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

/** Records the order in which a detached image gets its three loading attributes. */
function recordAssignments() {
    const order = [];
    const create = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementation(tag => {
        const element = create(tag);
        if (tag === 'img') {
            for (const name of ['loading', 'decoding', 'src']) {
                let value;
                Object.defineProperty(element, name, {
                    configurable: true,
                    get: () => value,
                    set: next => {
                        order.push(name);
                        value = next;
                    },
                });
            }
        }
        return element;
    });
    return order;
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe('lazy image', () => {
    test('is told to load lazily before it is given an address, so a detached image is not fetched at once', () => {
        const order = recordAssignments();

        const image = createLazyImage('/thumbnail?type=avatar&file=a.png', 'sb-test-avatar');

        expect(order).toEqual(['loading', 'decoding', 'src']);
        expect(image.loading).toBe('lazy');
        expect(image.decoding).toBe('async');
        expect(image.src).toBe('/thumbnail?type=avatar&file=a.png');
        expect(image.className).toBe('sb-test-avatar');
        expect(image.alt).toBe('');
    });

    test('takes an empty class name', () => {
        expect(createLazyImage('/x.png').className).toBe('');
    });
});

describe('every picker and avatar helper that builds a detached image uses it', () => {
    const files = [
        'sillybunny-conversation/pickers.js',
        'sillybunny-conversation/details/avatars.js',
        'sillybunny-conversation/details/pages/shared.js',
        'sillybunny-home/assistant-picker.js',
        'sillybunny-folder-manager.js',
        'sillybunny-persona-detail.js',
        'extensions/sillybunny-chats-archive/src/ui/sidebar.js',
    ];

    test.each(files)('%s', file => {
        const source = read(file);

        expect(source).toContain('createLazyImage');
        expect(source).not.toContain('createElement(\'img\')');
        expect(source).not.toContain('el(\'img\')');
        expect(source).not.toContain('element(\'img\', \'sb-persona-connection-avatar\')');
        expect(source).not.toContain('.loading = \'lazy\'');
    });
});
