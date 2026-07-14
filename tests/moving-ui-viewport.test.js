import { describe, expect, test } from '@jest/globals';

import { resolveMovingUIViewportState } from '../public/scripts/moving-ui-viewport.js';

describe('MovingUI viewport containment', () => {
    test('pulls a persisted panel back inside the viewport without changing its size', () => {
        const result = resolveMovingUIViewportState({
            position: 'fixed',
            width: 600,
            height: 500,
            left: 1800,
            top: 100,
            right: -1136,
            bottom: 200,
            margin: 'unset',
        }, {
            viewportWidth: 1264,
            viewportHeight: 800,
        });

        expect(result).toMatchObject({
            changed: true,
            canContain: true,
            state: {
                position: 'fixed',
                width: 600,
                height: 500,
                left: 664,
                top: 100,
                right: 0,
                bottom: 200,
                margin: 'unset',
            },
        });
    });

    test('clamps negative coordinates and panels larger than the viewport', () => {
        const result = resolveMovingUIViewportState({
            width: '1600px',
            height: '900px',
            left: '-240px',
            top: '-80px',
            right: '-96px',
            bottom: '-20px',
        }, {
            viewportWidth: 1280,
            viewportHeight: 720,
        });

        expect(result.state).toMatchObject({
            width: 1280,
            height: 720,
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        });
    });

    test('resolves right and bottom anchored legacy state before containing it', () => {
        const result = resolveMovingUIViewportState({
            width: 400,
            height: 300,
            right: -100,
            bottom: -50,
        }, {
            viewportWidth: 1000,
            viewportHeight: 700,
        });

        expect(result.state).toMatchObject({
            width: 400,
            height: 300,
            left: 600,
            top: 400,
            right: 0,
            bottom: 0,
        });
    });

    test('uses rendered bounds when CSS changes the persisted dimensions', () => {
        const result = resolveMovingUIViewportState({
            width: 900,
            height: 700,
            left: 500,
            top: 300,
            right: -400,
            bottom: -300,
        }, {
            viewportWidth: 1000,
            viewportHeight: 700,
            elementBounds: {
                left: 500,
                top: 300,
                right: 1250,
                bottom: 650,
                width: 750,
                height: 350,
            },
        });

        expect(result.state).toMatchObject({
            width: 750,
            height: 350,
            left: 250,
            top: 300,
            right: 0,
            bottom: 50,
        });
    });

    test('leaves incomplete hidden-panel state alone when no bounds can be resolved', () => {
        const state = { left: 2000, top: 100, margin: 'unset' };

        expect(resolveMovingUIViewportState(state, {
            viewportWidth: 1280,
            viewportHeight: 720,
        })).toEqual({
            state,
            changed: false,
            canContain: false,
        });
    });

    test('is stable once state is already contained', () => {
        const state = {
            width: 600,
            height: 500,
            left: 664,
            top: 100,
            right: 0,
            bottom: 200,
        };

        expect(resolveMovingUIViewportState(state, {
            viewportWidth: 1264,
            viewportHeight: 800,
        })).toEqual({
            state,
            changed: false,
            canContain: true,
        });
    });
});
