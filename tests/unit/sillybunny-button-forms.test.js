/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { describe, expect, test } from '@jest/globals';
import { BUTTON_FORMS, ICON, iconAndLabelButtons, markupOf, readPublic } from '../helpers/button-forms.js';

const textOf = button => button.textContent.replace(/\s+/g, ' ').trim();

describe('buttons of the changed surfaces show an icon or a label, not both', () => {
    for (const { file, selectors } of BUTTON_FORMS.filter(row => row.form === 'label')) {
        describe(`${file}, label form`, () => {
            const document_ = markupOf(file);
            test.each(selectors)('%s has a label and no icon', selector => {
                const buttons = [...document_.querySelectorAll(selector)];
                expect(buttons.length).toBeGreaterThan(0);
                expect(buttons.filter(button => button.querySelector(ICON))).toEqual([]);
                expect(buttons.filter(button => textOf(button) === '')).toEqual([]);
            });
        });
    }

    for (const { file, selectors } of BUTTON_FORMS.filter(row => row.form === 'icon')) {
        describe(`${file}, icon form`, () => {
            const document_ = markupOf(file);
            test.each(selectors)('%s has an icon, no text, and a tooltip that is its accessible name', selector => {
                const buttons = [...document_.querySelectorAll(selector)];
                expect(buttons.length).toBeGreaterThan(0);
                expect(buttons.filter(button => !button.querySelector(ICON))).toEqual([]);
                expect(buttons.map(textOf)).toEqual(buttons.map(() => ''));
                expect(buttons.map(button => button.getAttribute('title'))).toEqual(buttons.map(button => button.getAttribute('aria-label')));
                expect(buttons.map(button => button.getAttribute('aria-label')).filter(label => !label)).toEqual([]);
            });
        });
    }

    test('a button that holds an icon and text is found', () => {
        const probe = new DOMParser().parseFromString('<body><button><i class="fa-solid fa-plus"></i><span>Add</span></button><button aria-label="Add"><i class="fa-solid fa-plus"></i></button><button>Add</button></body>', 'text/html');
        expect(iconAndLabelButtons(probe)).toHaveLength(1);
    });

    test('the buttons that scripts build with the DOM API carry no icon', () => {
        const backups = readPublic('scripts/chat-backups.js');
        expect(backups).not.toMatch(/(previewButton|cleanupButton)\.innerHTML/);
        const selfie = readPublic('scripts/sillybunny-conversation/timeline-render.js').match(/sb-conversation-selfie-action';[\s\S]*?button\.innerHTML = '([^']*)'/);
        expect(selfie).not.toBeNull();
        const content = new DOMParser().parseFromString(`<body><button>${selfie[1]}</button></body>`, 'text/html');
        expect(iconAndLabelButtons(content)).toHaveLength(0);
        expect(content.body.textContent).toBe('Generate Selfie');
    });
});
