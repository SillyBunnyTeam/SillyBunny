import { describe, expect, test } from '@jest/globals';
import { createDefinitionsReveal, REVEALED_CLASS } from '../../public/scripts/sillybunny-editor/rows.js';

function setup(initialId = 'a.png') {
    const classes = new Set();
    const listeners = [];
    const sheet = { classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)), contains: name => classes.has(name) } };
    const button = { addEventListener: (type, handler) => listeners.push(handler) };
    const state = { id: initialId, revealed: 0 };
    const reveal = createDefinitionsReveal({ sheet, button, getEntityId: () => state.id, onReveal: () => { state.revealed++; } });
    return { reveal, classes, click: () => listeners.forEach(handler => handler()), state };
}

describe('definitions reveal', () => {
    test('starts hidden', () => {
        const { classes } = setup();
        expect(classes.has(REVEALED_CLASS)).toBe(false);
    });

    test('a press reveals the definitions of the open character', () => {
        const { classes, click, state } = setup();
        click();
        expect(classes.has(REVEALED_CLASS)).toBe(true);
        expect(state.revealed).toBe(1);
    });

    test('reopening the same character keeps the reveal', () => {
        const { reveal, classes, click } = setup();
        click();
        reveal.follow('a.png');
        expect(classes.has(REVEALED_CLASS)).toBe(true);
    });

    test('another character hides the definitions again', () => {
        const { reveal, classes, click } = setup();
        click();
        reveal.follow('b.png');
        expect(classes.has(REVEALED_CLASS)).toBe(false);
    });

    test('closing the editor hides the definitions again', () => {
        const { reveal, classes, click } = setup();
        click();
        reveal.reset();
        expect(classes.has(REVEALED_CLASS)).toBe(false);
    });
});
