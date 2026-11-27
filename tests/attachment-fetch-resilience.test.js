import { describe, expect, jest, test } from '@jest/globals';
import vm from 'node:vm';
import { loadDeclarations } from './util/load-declarations.js';

function createChatsContext({ fetchImpl, deleteAttachment, uploadFileAttachmentToServer, callGenericPopup, renderExtensionTemplateAsync, createObjectURL } = {}) {
    const toastr = { error: jest.fn(), warning: jest.fn(), success: jest.fn(), info: jest.fn() };
    const context = vm.createContext({
        fetch: fetchImpl ?? jest.fn(),
        getRequestHeaders: () => ({}),
        toastr,
        t: (strings, ...values) => strings.reduce((acc, part, idx) => acc + part + (values[idx] ?? ''), ''),
        console: { error: jest.fn(), debug: jest.fn(), warn: jest.fn(), info: jest.fn(), log: jest.fn() },
        Blob,
        File: class MockFile extends Blob {
            constructor(parts, name, options) {
                super(parts, options);
                this.name = name;
            }
        },
        URL: { createObjectURL: createObjectURL ?? jest.fn(() => 'blob:mock'), revokeObjectURL: jest.fn() },
        document: { createElement: jest.fn(() => ({ click: jest.fn() })) },
        $: jest.fn(() => ({ find: () => ({ addClass: () => ({ text: jest.fn() }), val: () => ({ on: jest.fn() }) }), addClass: function () { return this; } })),
        addCopyToCodeBlocks: jest.fn(),
        getAvailableTargets: () => ['global', 'character'],
        renderExtensionTemplateAsync: renderExtensionTemplateAsync ?? jest.fn(async () => '<div />'),
        callGenericPopup: callGenericPopup ?? jest.fn(async () => 1),
        POPUP_TYPE: { CONFIRM: 'confirm', TEXT: 'text' },
        POPUP_RESULT: { AFFIRMATIVE: 1 },
        deleteAttachment: deleteAttachment ?? jest.fn(async () => true),
        uploadFileAttachmentToServer: uploadFileAttachmentToServer ?? jest.fn(async () => {}),
    });

    loadDeclarations(context, 'scripts/chats.js', [
        'getFileAttachment',
        'appendFileContent',
        'openFilePopup',
        'editAttachment',
        'downloadAttachment',
        'moveAttachment',
    ]);

    return { context, toastr };
}

describe('attachment fetch error resilience (ST #6113)', () => {
    test('getFileAttachment passes string message to toastr.error and resolves undefined on failure', async () => {
        const { context, toastr } = createChatsContext({
            fetchImpl: jest.fn(async () => ({ ok: false, text: async () => 'Not Found' })),
        });

        const result = await context.getFileAttachment('/user/files/missing.txt');

        expect(result).toBeUndefined();
        expect(toastr.error).toHaveBeenCalledWith('Not Found', 'Could not download file');
        expect(typeof toastr.error.mock.calls[0][0]).toBe('string');
    });

    test('appendFileContent returns original text and omits extra.fileLength when all attachments fail', async () => {
        const { context } = createChatsContext({
            fetchImpl: jest.fn(async () => ({ ok: false, text: async () => 'Missing' })),
        });
        const message = { extra: { fileLength: 12, files: [{ url: '/user/files/missing.txt' }] } };

        const result = await context.appendFileContent(message, 'Hello world');

        expect(result).toBe('Hello world');
        expect(message.extra.fileLength).toBeUndefined();
    });

    test('moveAttachment aborts before deleting or uploading when attachment download fails', async () => {
        const deleteAttachment = jest.fn(async () => true);
        const uploadFileAttachmentToServer = jest.fn(async () => {});
        const callback = jest.fn();
        let inputHandler;
        const { context } = createChatsContext({
            fetchImpl: jest.fn(async () => ({ ok: false, text: async () => 'Network error' })),
            deleteAttachment,
            uploadFileAttachmentToServer,
        });
        context.$ = jest.fn(() => ({
            find: () => ({
                val: () => ({
                    on: (_evt, fn) => { inputHandler = fn; },
                }),
            }),
        }));
        context.callGenericPopup = jest.fn(async () => {
            inputHandler.call({ value: 'character' });
            return 1;
        });
        const originalDollar = context.$;
        context.$ = jest.fn(arg => (arg && typeof arg === 'object' && 'value' in arg) ? { val: () => arg.value } : originalDollar(arg));

        await context.moveAttachment({ url: '/user/files/doc.txt', name: 'doc.txt' }, 'global', callback);

        expect(deleteAttachment).not.toHaveBeenCalled();
        expect(uploadFileAttachmentToServer).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    test('editAttachment and downloadAttachment and openFilePopup abort when attachment fetch fails', async () => {
        const callGenericPopup = jest.fn(async () => 1);
        const deleteAttachment = jest.fn(async () => true);
        const createObjectURL = jest.fn(() => 'blob:mock');
        const { context } = createChatsContext({
            fetchImpl: jest.fn(async () => ({ ok: false, text: async () => '404' })),
            callGenericPopup,
            deleteAttachment,
            createObjectURL,
        });
        const attachment = { url: '/user/files/missing.txt', name: 'missing.txt' };

        await context.editAttachment(attachment, 'global', jest.fn());
        await context.downloadAttachment(attachment);
        await context.openFilePopup(attachment);

        expect(callGenericPopup).not.toHaveBeenCalled();
        expect(deleteAttachment).not.toHaveBeenCalled();
        expect(createObjectURL).not.toHaveBeenCalled();
    });
});
