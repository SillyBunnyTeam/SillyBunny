import { describe, expect, test } from '@jest/globals';
import { judgeRendered } from '../helpers/copy-judge.js';

describe('judgeRendered', () => {
    test('passes a label in the form of its role, including the known cases', () => {
        expect(judgeRendered('row title', 'Keep API/Model Linked to Preset')).toBeNull();
        expect(judgeRendered('heading', 'Delete Folder?')).toBeNull();
        expect(judgeRendered('heading', 'What is Pathfinder?')).toBeNull();
        expect(judgeRendered('check or radio label', 'Keep sampling settings linked to preset')).toBeNull();
    });

    test('reports a label in the wrong form with the form that the rule gives', () => {
        expect(judgeRendered('row title', 'Check for updates')).toEqual({ kind: 'header capitalisation', expected: 'Check for Updates' });
        expect(judgeRendered('check or radio label', 'Keep Sampling Settings Linked to Preset')).toEqual({ kind: 'sentence capitalisation', expected: 'Keep sampling settings linked to preset' });
    });

    test('a tooltip that is a sentence needs other words, unless it already reads as a heading', () => {
        expect(judgeRendered('tooltip', 'Automatically clear browser cache and temporary UI data after SillyBunny updates, then reload.')).toEqual({ kind: 'words', expected: '' });
        expect(judgeRendered('tooltip', 'Run This Companion on the Latest Assistant Reply')).toBeNull();
    });

    test('leaves the placeholders of the copy pass and a template or macro alone', () => {
        expect(judgeRendered('button', 'TODO(copy)')).toBeNull();
        expect(judgeRendered('tooltip', 'lorum ipsum')).toBeNull();
        expect(judgeRendered('row title', 'Show {{char}}: in responses')).toBeNull();
        expect(judgeRendered('button', '12')).toBeNull();
    });
});
