/**
 * @jest-environment jsdom
 */
/* eslint-disable playwright/no-standalone-expect -- Jest contracts for DOM helpers. */
import { afterEach, describe, expect, test } from '@jest/globals';
import { captureHomeFocus, restoreHomeFocus } from '../../public/scripts/sillybunny-home/focus.js';

function renderPanel(files, { hiddenFiles = [] } = {}) {
    const panel = document.createElement('div');
    panel.className = 'welcomePanel';
    panel.innerHTML = `
        <button type="button" class="sbHomeMenuButton">Menu</button>
        <button type="button" class="welcomeRecentTab">All</button>
        ${files.map(file => `
            <article class="recentChat${hiddenFiles.includes(file) ? ' hidden' : ''}" data-file="${file}" data-avatar="a.png" data-group="" data-conversation-branch-id="">
                <button type="button" class="recentChatOpen">Open ${file}</button>
                <button type="button" class="pinChat">Pin ${file}</button>
                <button type="button" class="chatMenu">Menu ${file}</button>
            </article>`).join('')}`;
    return panel;
}

function mount(panel) {
    document.body.append(panel);
    return panel;
}

const control = (panel, file, selector) => panel.querySelector(`.recentChat[data-file="${file}"] ${selector}`);

afterEach(() => {
    document.body.replaceChildren();
});

describe('captureHomeFocus', () => {
    test('records the control and the row of a focused row control', () => {
        const panel = mount(renderPanel(['one', 'two']));

        const target = captureHomeFocus(panel, control(panel, 'two', '.pinChat'));

        expect(target).toMatchObject({ control: 'pin', identity: { file: 'two', avatar: 'a.png', group: '', branchId: '' }, index: 1 });
    });

    test.each([
        ['.recentChatOpen', 'open'],
        ['.pinChat', 'pin'],
        ['.chatMenu', 'chat-menu'],
    ])('names the %s control', (selector, name) => {
        const panel = mount(renderPanel(['one']));

        expect(captureHomeFocus(panel, control(panel, 'one', selector)).control).toBe(name);
    });

    test('treats the main menu button and other panel controls as the main menu', () => {
        const panel = mount(renderPanel(['one']));

        expect(captureHomeFocus(panel, panel.querySelector('.sbHomeMenuButton'))).toEqual({ control: 'main-menu', identity: null, index: -1 });
        expect(captureHomeFocus(panel, panel.querySelector('.welcomeRecentTab')).control).toBe('main-menu');
    });

    test('records nothing when the focused element is outside the panel or missing', () => {
        const panel = mount(renderPanel(['one']));
        const outside = document.createElement('button');
        document.body.append(outside);

        expect(captureHomeFocus(panel, outside)).toBeNull();
        expect(captureHomeFocus(panel, document.body)).toBeNull();
        expect(captureHomeFocus(panel, null)).toBeNull();
        expect(captureHomeFocus(null, outside)).toBeNull();
    });

    test('counts only rows that are shown when it records the row position', () => {
        const panel = mount(renderPanel(['one', 'two', 'three'], { hiddenFiles: ['one'] }));

        expect(captureHomeFocus(panel, control(panel, 'three', '.pinChat')).index).toBe(1);
    });
});

describe('restoreHomeFocus', () => {
    test('focuses the same control in the same row of the new panel', () => {
        const old = mount(renderPanel(['one', 'two']));
        const target = captureHomeFocus(old, control(old, 'two', '.pinChat'));
        const next = renderPanel(['two', 'one']);
        old.replaceWith(next);

        const focused = restoreHomeFocus(next, target);

        expect(focused).toBe(control(next, 'two', '.pinChat'));
        expect(document.activeElement).toBe(control(next, 'two', '.pinChat'));
    });

    test('focuses the row menu trigger of a chat menu action', () => {
        const old = mount(renderPanel(['one']));
        const target = captureHomeFocus(old, control(old, 'one', '.chatMenu'));
        const next = renderPanel(['one']);
        old.replaceWith(next);

        restoreHomeFocus(next, target);

        expect(document.activeElement).toBe(control(next, 'one', '.chatMenu'));
    });

    test('focuses the main menu button when the target was the main menu', () => {
        const old = mount(renderPanel(['one']));
        const target = captureHomeFocus(old, old.querySelector('.sbHomeMenuButton'));
        const next = renderPanel(['one']);
        old.replaceWith(next);

        restoreHomeFocus(next, target);

        expect(document.activeElement).toBe(next.querySelector('.sbHomeMenuButton'));
    });

    test('moves to the open control of the row that took the place of a deleted row', () => {
        const old = mount(renderPanel(['one', 'two', 'three']));
        const target = captureHomeFocus(old, control(old, 'two', '.chatMenu'));
        const next = renderPanel(['one', 'three']);
        old.replaceWith(next);

        restoreHomeFocus(next, target);

        expect(document.activeElement).toBe(control(next, 'three', '.recentChatOpen'));
    });

    test('moves to the last row when the deleted row was the last one', () => {
        const old = mount(renderPanel(['one', 'two']));
        const target = captureHomeFocus(old, control(old, 'two', '.chatMenu'));
        const next = renderPanel(['one']);
        old.replaceWith(next);

        restoreHomeFocus(next, target);

        expect(document.activeElement).toBe(control(next, 'one', '.recentChatOpen'));
    });

    test('moves to the main menu button when no row is left', () => {
        const old = mount(renderPanel(['one']));
        const target = captureHomeFocus(old, control(old, 'one', '.chatMenu'));
        const next = renderPanel([]);
        old.replaceWith(next);

        restoreHomeFocus(next, target);

        expect(document.activeElement).toBe(next.querySelector('.sbHomeMenuButton'));
    });

    test('falls back to the open control of the row when the control cannot take focus', () => {
        const old = mount(renderPanel(['one', 'two']));
        const target = captureHomeFocus(old, control(old, 'two', '.pinChat'));
        const next = renderPanel(['one', 'two']);
        next.querySelector('.recentChat[data-file="two"] .pinChat').disabled = true;
        old.replaceWith(next);

        restoreHomeFocus(next, target);

        expect(document.activeElement).toBe(control(next, 'two', '.recentChatOpen'));
    });

    test('does nothing without a target', () => {
        const panel = mount(renderPanel(['one']));

        expect(restoreHomeFocus(panel, null)).toBeNull();
        expect(document.activeElement).toBe(document.body);
    });
});

describe('tile and card controls', () => {
    function renderSections() {
        const panel = renderPanel([]);
        panel.insertAdjacentHTML('beforeend', `
            <a class="sbHomeForkLink" href="#fork">Fork</a>
            <button type="button" class="sbHomeTile" data-sb-home-key="extras">Bundled Extras</button>
            <div class="sbHomeCard" data-sb-home-key="assistant-reisen">
                <button type="button" class="sbHomeCardOpen">Open</button>
                <button type="button" class="sbHomeFootButton">Start</button>
                <button type="button" class="sbHomeRowMenu">Menu</button>
            </div>`);
        return panel;
    }

    test('finds a focused card control again by the card key, wherever the control sits', () => {
        const oldPanel = mount(renderSections());
        const target = captureHomeFocus(oldPanel, oldPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeRowMenu'));
        oldPanel.remove();
        const newPanel = mount(renderSections());

        expect(restoreHomeFocus(newPanel, target)).toBe(newPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeRowMenu'));
        expect(document.activeElement).toBe(newPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeRowMenu'));
    });

    test('keeps focus on a tile, which is itself the control', () => {
        const selector = '[data-sb-home-key="extras"]';
        const oldPanel = mount(renderSections());
        const target = captureHomeFocus(oldPanel, oldPanel.querySelector(selector));
        oldPanel.remove();
        const newPanel = mount(renderSections());

        expect(restoreHomeFocus(newPanel, target)).toBe(newPanel.querySelector(selector));
    });

    test('falls back to the main menu button when the card is gone', () => {
        const oldPanel = mount(renderSections());
        const target = captureHomeFocus(oldPanel, oldPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeCardOpen'));
        oldPanel.remove();
        const newPanel = mount(renderPanel([]));

        expect(restoreHomeFocus(newPanel, target)).toBe(newPanel.querySelector('.sbHomeMenuButton'));
    });

    test('falls back to the first control of the same card when the card is there and the control is not', () => {
        const oldPanel = mount(renderSections());
        const target = captureHomeFocus(oldPanel, oldPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeRowMenu'));
        oldPanel.remove();
        const newPanel = mount(renderSections());
        newPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeRowMenu').remove();
        newPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeFootButton').remove();

        expect(restoreHomeFocus(newPanel, target)).toBe(newPanel.querySelector('[data-sb-home-key="assistant-reisen"] .sbHomeCardOpen'));
    });

    describe('the Connect a Model button of a card', () => {
        const withConnect = ['open', 'connect', 'start', 'menu'];
        const withoutConnect = ['open', 'start', 'menu'];
        const HTML = {
            open: '<button type="button" class="sbHomeCardOpen">Open</button>',
            connect: '<button type="button" class="sbHomeCardConnect">Connect a Model</button>',
            start: '<button type="button" class="sbHomeFootButton">Start</button>',
            menu: '<button type="button" class="sbHomeRowMenu">Menu</button>',
        };
        const renderCard = (parts) => {
            const panel = renderPanel([]);
            panel.insertAdjacentHTML('beforeend', `<div class="sbHomeCard" data-sb-home-key="assistant-reisen">${parts.map(part => HTML[part]).join('')}</div>`);
            return panel;
        };
        const control = (panel, selector) => panel.querySelector(`[data-sb-home-key="assistant-reisen"] ${selector}`);

        test('is not counted, so a card that gains it, such as a restored one, keeps focus on the same footer button', () => {
            const oldPanel = mount(renderCard(withoutConnect));
            const target = captureHomeFocus(oldPanel, control(oldPanel, '.sbHomeFootButton'));
            oldPanel.remove();
            const newPanel = mount(renderCard(withConnect));

            expect(restoreHomeFocus(newPanel, target)).toBe(control(newPanel, '.sbHomeFootButton'));
        });

        test('is not counted, so a card that loses it keeps focus on the same footer button', () => {
            const oldPanel = mount(renderCard(withConnect));
            const target = captureHomeFocus(oldPanel, control(oldPanel, '.sbHomeFootButton'));
            oldPanel.remove();
            const newPanel = mount(renderCard(withoutConnect));

            expect(restoreHomeFocus(newPanel, target)).toBe(control(newPanel, '.sbHomeFootButton'));
        });

        test('has focus restored to itself', () => {
            const oldPanel = mount(renderCard(withConnect));
            const target = captureHomeFocus(oldPanel, control(oldPanel, '.sbHomeCardConnect'));
            oldPanel.remove();
            const newPanel = mount(renderCard(withConnect));

            expect(target.section).toEqual({ key: 'assistant-reisen', part: 'connect' });
            expect(restoreHomeFocus(newPanel, target)).toBe(control(newPanel, '.sbHomeCardConnect'));
        });

        test('sends focus to the first control of the card when it is gone from the new card', () => {
            const oldPanel = mount(renderCard(withConnect));
            const target = captureHomeFocus(oldPanel, control(oldPanel, '.sbHomeCardConnect'));
            oldPanel.remove();
            const newPanel = mount(renderCard(withoutConnect));

            expect(restoreHomeFocus(newPanel, target)).toBe(control(newPanel, '.sbHomeCardOpen'));
        });

        test('sends focus to the first control of the card when it is hidden, as it is while online', () => {
            const oldPanel = mount(renderCard(withConnect));
            const target = captureHomeFocus(oldPanel, control(oldPanel, '.sbHomeCardConnect'));
            oldPanel.remove();
            const newPanel = mount(renderCard(withConnect));
            // A browser does not focus an element that is not rendered; jsdom does, so the refusal is stood in for.
            control(newPanel, '.sbHomeCardConnect').focus = () => {};

            expect(restoreHomeFocus(newPanel, target)).toBe(control(newPanel, '.sbHomeCardOpen'));
        });

        test('sends focus to the main menu button when the card is gone', () => {
            const oldPanel = mount(renderCard(withConnect));
            const target = captureHomeFocus(oldPanel, control(oldPanel, '.sbHomeCardConnect'));
            oldPanel.remove();
            const newPanel = mount(renderPanel([]));

            expect(restoreHomeFocus(newPanel, target)).toBe(newPanel.querySelector('.sbHomeMenuButton'));
        });
    });

    test('a control outside any keyed tile or card is still the main menu', () => {
        const panel = mount(renderSections());

        expect(captureHomeFocus(panel, panel.querySelector('.sbHomeForkLink')).control).toBe('main-menu');
    });
});
