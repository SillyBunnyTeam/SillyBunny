import { describe, expect, jest, test } from '@jest/globals';
import { renameChatFile, shouldFallbackChatRename } from '../src/chat-rename.js';

describe('shouldFallbackChatRename', () => {
    test('allows cross-device rename fallback on all platforms', () => {
        expect(shouldFallbackChatRename({ code: 'EXDEV' }, 'linux')).toBe(true);
    });

    test('allows Windows EPERM fallback only on Windows', () => {
        expect(shouldFallbackChatRename({ code: 'EPERM' }, 'win32')).toBe(true);
        expect(shouldFallbackChatRename({ code: 'EPERM' }, 'linux')).toBe(false);
    });
});

describe('renameChatFile', () => {
    test('uses atomic rename when available', () => {
        const fsModule = {
            renameSync: jest.fn(),
            copyFileSync: jest.fn(),
            unlinkSync: jest.fn(),
        };

        expect(renameChatFile('/old.jsonl', '/new.jsonl', { fsModule, platform: 'linux' })).toEqual({ method: 'atomic' });
        expect(fsModule.renameSync).toHaveBeenCalledWith('/old.jsonl', '/new.jsonl');
        expect(fsModule.copyFileSync).not.toHaveBeenCalled();
        expect(fsModule.unlinkSync).not.toHaveBeenCalled();
    });

    test('falls back to copy and unlink for cross-device renames', () => {
        const error = Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
        const fsModule = {
            renameSync: jest.fn(() => { throw error; }),
            copyFileSync: jest.fn(),
            unlinkSync: jest.fn(),
        };

        expect(renameChatFile('/old.jsonl', '/new.jsonl', { fsModule, platform: 'linux' })).toEqual({ method: 'fallback', fallbackCode: 'EXDEV' });
        expect(fsModule.copyFileSync).toHaveBeenCalledWith('/old.jsonl', '/new.jsonl');
        expect(fsModule.unlinkSync).toHaveBeenCalledWith('/old.jsonl');
    });

    test('falls back to copy and unlink for Windows EPERM renames', () => {
        const error = Object.assign(new Error('locked rename'), { code: 'EPERM' });
        const fsModule = {
            renameSync: jest.fn(() => { throw error; }),
            copyFileSync: jest.fn(),
            unlinkSync: jest.fn(),
        };

        expect(renameChatFile('/old.jsonl', '/new.jsonl', { fsModule, platform: 'win32' })).toEqual({ method: 'fallback', fallbackCode: 'EPERM' });
        expect(fsModule.copyFileSync).toHaveBeenCalledWith('/old.jsonl', '/new.jsonl');
        expect(fsModule.unlinkSync).toHaveBeenCalledWith('/old.jsonl');
    });

    test('throws unexpected rename failures without copying', () => {
        const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
        const fsModule = {
            renameSync: jest.fn(() => { throw error; }),
            copyFileSync: jest.fn(),
            unlinkSync: jest.fn(),
        };

        expect(() => renameChatFile('/old.jsonl', '/new.jsonl', { fsModule, platform: 'linux' })).toThrow(error);
        expect(fsModule.copyFileSync).not.toHaveBeenCalled();
        expect(fsModule.unlinkSync).not.toHaveBeenCalled();
    });

    test('removes the copied destination if fallback cannot delete the original', () => {
        const renameError = Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
        const unlinkError = new Error('cannot delete original');
        const fsModule = {
            renameSync: jest.fn(() => { throw renameError; }),
            copyFileSync: jest.fn(),
            unlinkSync: jest.fn()
                .mockImplementationOnce(() => { throw unlinkError; })
                .mockImplementationOnce(() => {}),
        };

        expect(() => renameChatFile('/old.jsonl', '/new.jsonl', { fsModule, platform: 'linux' })).toThrow(unlinkError);
        expect(fsModule.unlinkSync).toHaveBeenNthCalledWith(1, '/old.jsonl');
        expect(fsModule.unlinkSync).toHaveBeenNthCalledWith(2, '/new.jsonl');
    });
});
