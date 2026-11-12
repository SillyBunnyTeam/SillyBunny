/* eslint-disable playwright/no-standalone-expect -- Jest contracts for pure functions. */
import { describe, expect, jest, test } from '@jest/globals';
import { SHELL_TARGETS, openShellTarget } from '../../public/scripts/sillybunny-home/shell-targets.js';

function fakeShell() {
    return {
        openTab: jest.fn(),
        openCharacters: jest.fn(),
        openModeMenu: jest.fn(),
        revealSetting: jest.fn(),
    };
}

describe('Home shell targets', () => {
    test('Connections opens Backend, Connections', () => {
        const shell = fakeShell();

        openShellTarget('connections', shell);

        expect(shell.openTab).toHaveBeenCalledWith('left', 'connections');
    });

    test('Presets opens Backend, Presets', () => {
        const shell = fakeShell();

        openShellTarget('presets', shell);

        expect(shell.openTab).toHaveBeenCalledWith('left', 'prompting');
    });

    test('Characters opens the character list by name, so a visited tab does not take over', () => {
        const shell = fakeShell();

        openShellTarget('characters', shell);

        expect(shell.openTab).toHaveBeenCalledWith('characters', 'characters');
        expect(shell.openCharacters).not.toHaveBeenCalled();
    });

    test('Personas opens Characters, Personas', () => {
        const shell = fakeShell();

        openShellTarget('personas', shell);

        expect(shell.openTab).toHaveBeenCalledWith('characters', 'persona');
    });

    test('the mode menu opens the top-bar mode switcher menu', () => {
        const shell = fakeShell();

        openShellTarget('mode-menu', shell);

        expect(shell.openModeMenu).toHaveBeenCalledTimes(1);
    });

    test('UI Theme reveals the theme select in Customize, Appearance', () => {
        const shell = fakeShell();

        openShellTarget('ui-theme', shell);

        expect(shell.revealSetting).toHaveBeenCalledWith('right', 'appearance', '#themes');
    });

    test('names every target once', () => {
        expect([...SHELL_TARGETS].sort()).toEqual(['characters', 'connections', 'mode-menu', 'personas', 'presets', 'ui-theme']);
    });

    test('fails loudly on an unknown target', () => {
        expect(() => openShellTarget('nowhere', fakeShell())).toThrow(/unknown/i);
    });

    test('fails loudly when the shell cannot do what the target needs', () => {
        expect(() => openShellTarget('connections', {})).toThrow(/shell/i);
        expect(() => openShellTarget('connections', undefined)).toThrow(/shell/i);
    });
});
