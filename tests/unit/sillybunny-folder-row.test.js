/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom assertions. */
import { jest, describe, test, expect, beforeEach } from '@jest/globals';

const plays = [];
const play = jest.fn((row, keyframes, options) => { plays.push({ row, keyframes, options }); return {}; });
const prefersReducedMotion = jest.fn(() => false);
await jest.unstable_mockModule('../../public/scripts/sillybunny-motion.js', () => ({
    MOTION_SLOW: 250, play, prefersReducedMotion,
}));
await jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => strings.reduce((text, part, index) => text + part + (values[index] ?? ''), ''),
}));
const { createFolderMotion, createFolderRow } = await import('../../public/scripts/sillybunny-editor/folder-row.js');

let container;
let header;

function member(id, { start = false } = {}) {
    const row = document.createElement('div');
    row.className = `is-folder-member${start ? ' is-folder-section-start' : ''}`;
    row.dataset.id = id;
    return row;
}

beforeEach(() => {
    plays.length = 0;
    play.mockClear();
    prefersReducedMotion.mockReturnValue(false);
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.append(container);
    const factory = createFolderRow({ key: 'folder:a', folder: { id: 'a', name: 'A', scope: 'personas' }, count: 2, countLabel: '2 personas', expanded: true });
    header = factory.row;
    container.append(header, member('one'), member('two'), member('three', { start: true }));
});

describe('folder row chevron', () => {
    test('keeps one glyph and reports the state through aria-expanded', () => {
        const chevron = header.querySelector('.ds-entity-row__chevron');
        expect(chevron.classList.contains('fa-chevron-down')).toBe(true);
        expect(chevron.classList.contains('fa-chevron-up')).toBe(false);
        expect(header.getAttribute('aria-expanded')).toBe('true');
    });
});

describe('folder row accessible name', () => {
    // The name is computed from the content (WCAG 2.5.3 Label in Name), so it holds the visible title, then the count, and no more.
    const visibleText = row => [...row.querySelectorAll('.ds-entity-row__title, .ds-entity-row__subtitle')].map(node => node.textContent).join(' ');
    const contentOutsideName = row => [...row.querySelectorAll('.ds-entity-row__chevron, .sb-folder-row__dot')].map(node => node.getAttribute('aria-hidden'));

    test('has no aria-label, so the name is the visible name and count', () => {
        expect(header.hasAttribute('aria-label')).toBe(false);
        expect(header.getAttribute('role')).toBe('button');
        expect(visibleText(header)).toBe('A 2 personas');
    });

    test('keeps the chevron and the colour dot out of the name', () => {
        expect(contentOutsideName(header)).toEqual(['true', 'true']);
        expect(header.querySelector('img, [aria-label], [title]')).toBeNull();
    });

    test('an update renames the row without adding an aria-label', () => {
        const factory = createFolderRow({ key: 'folder:b', folder: { id: 'b', name: 'B', scope: 'groups' }, count: 1, countLabel: '1 group', expanded: false });
        factory.update({ folder: { id: 'b', name: 'Bee', scope: 'groups', color: '#ff0000' }, countLabel: '3 groups', scope: 'groups', expanded: true });
        expect(factory.row.hasAttribute('aria-label')).toBe(false);
        expect(visibleText(factory.row)).toBe('Bee 3 groups');
        expect(factory.row.querySelector('.sb-folder-row__dot').style.getPropertyValue('--sb-folder-color')).toBe('#ff0000');
    });
});

describe('folder motion', () => {
    test('closing animates the folder\'s own rows out, then commits once the last has ended', () => {
        const motion = createFolderMotion();
        const commit = jest.fn();
        motion.toggle(header, true, commit);
        expect(plays.map(entry => entry.row.dataset.id)).toEqual(['one', 'two']);
        expect(plays.every(entry => entry.options.fill === 'forwards' && entry.options.inert === true)).toBe(true);
        expect(header.getAttribute('aria-expanded')).toBe('false');
        expect(commit).not.toHaveBeenCalled();
        plays[0].options.onEnd();
        expect(commit).not.toHaveBeenCalled();
        plays[1].options.onEnd();
        expect(commit).toHaveBeenCalledTimes(1);
    });

    test('a second click while the rows animate out is ignored', () => {
        const motion = createFolderMotion();
        const commit = jest.fn();
        motion.toggle(header, true, commit);
        motion.toggle(header, true, commit);
        expect(plays).toHaveLength(2);
        plays.forEach(entry => entry.options.onEnd());
        expect(commit).toHaveBeenCalledTimes(1);
        motion.toggle(header, true, commit);
        expect(plays).toHaveLength(4);
    });

    test('opening commits at once and reveals the rows the render adds', () => {
        const motion = createFolderMotion();
        const commit = jest.fn();
        motion.toggle(header, false, commit);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(motion.pending).toBe(true);
        expect(plays).toHaveLength(0);
        motion.reveal(container);
        expect(plays.map(entry => entry.row.dataset.id)).toEqual(['one', 'two']);
        expect(plays.every(entry => entry.options.fill === 'none')).toBe(true);
        expect(motion.pending).toBe(false);
        motion.reveal(container);
        expect(plays).toHaveLength(2);
    });

    test('a reveal that waited past its window is dropped', () => {
        const motion = createFolderMotion();
        const now = jest.spyOn(performance, 'now');
        now.mockReturnValue(1000);
        motion.toggle(header, false, jest.fn());
        now.mockReturnValue(5000);
        expect(motion.pending).toBe(false);
        motion.reveal(container);
        expect(plays).toHaveLength(0);
        now.mockRestore();
    });

    test('reduced motion and empty folders commit without animating', () => {
        const motion = createFolderMotion();
        const commit = jest.fn();
        prefersReducedMotion.mockReturnValue(true);
        motion.toggle(header, true, commit);
        motion.toggle(header, false, commit);
        expect(commit).toHaveBeenCalledTimes(2);
        expect(motion.pending).toBe(false);
        prefersReducedMotion.mockReturnValue(false);
        container.replaceChildren(header);
        motion.toggle(header, true, commit);
        expect(commit).toHaveBeenCalledTimes(3);
        expect(plays).toHaveLength(0);
    });
});
