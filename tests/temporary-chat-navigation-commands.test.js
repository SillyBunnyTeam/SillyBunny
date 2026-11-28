/** @jest-environment jsdom */
/* global globalThis */
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { importPowerUserModule } from './util/power-user-harness.js';

afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
});

describe('/random temporary chat navigation seam', () => {
    async function setupRandom({ flushResult = true } = {}) {
        jest.resetModules();
        const log = [];
        const characters = [
            { name: 'Bunny', avatar: 'bunny.png', chat: 'bunny-chat' },
            { name: 'Seraphina', avatar: 'seraphina.png', chat: 'seraphina-chat' },
        ];
        const flushPendingChatSavesForNavigation = jest.fn(async () => {
            log.push('flush');
            return flushResult;
        });
        const setCharacterId = jest.fn(id => log.push(`setCharacterId ${id}`));
        const reloadCurrentChat = jest.fn(async () => log.push('reload'));

        const loaded = await importPowerUserModule({
            script: {
                characters,
                flushPendingChatSavesForNavigation,
                setCharacterId,
                reloadCurrentChat,
            },
        });
        await loaded.runReady();

        // Pick index 1 ('Seraphina') deterministically.
        jest.spyOn(Math, 'random').mockReturnValue(0.99);

        const randomCmd = loaded.mocks.registeredCommands.get('random');
        expect(randomCmd).toBeTruthy();
        return { ...loaded, log, flushPendingChatSavesForNavigation, setCharacterId, reloadCurrentChat, runRandom: randomCmd.callback };
    }

    test('/random asks the leave seam before it switches character, then switches and reloads', async () => {
        const harness = await setupRandom({ flushResult: true });

        await expect(harness.runRandom(null, '')).resolves.toBe('Seraphina');

        expect(harness.log).toEqual(['flush', 'setCharacterId 1', 'reload']);
        expect(harness.mocks.script.setActiveCharacter).toHaveBeenCalledWith('seraphina.png');
    });

    test('/random picks the character first and neither asks nor switches when there is none to pick', async () => {
        const harness = await setupRandom({ flushResult: true });

        await expect(harness.runRandom(null, 'nobody')).resolves.toBeUndefined();

        expect(harness.flushPendingChatSavesForNavigation).not.toHaveBeenCalled();
        expect(harness.setCharacterId).not.toHaveBeenCalled();
        expect(globalThis.toastr.error).toHaveBeenCalled();
    });

    test('/random stays put when the user declines to leave a temporary chat', async () => {
        const harness = await setupRandom({ flushResult: false });

        await expect(harness.runRandom(null, '')).resolves.toBe('');

        expect(harness.setCharacterId).not.toHaveBeenCalled();
        expect(harness.reloadCurrentChat).not.toHaveBeenCalled();
    });
});
