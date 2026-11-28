/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const shellSource = readFileSync(new URL('../public/scripts/sillybunny-tabs.js', import.meta.url), 'utf8');
const chatActionsSource = readFileSync(new URL('../public/scripts/sillybunny-tabs/chat-actions-search.js', import.meta.url), 'utf8');

// The chat actions module defines its functions inside a factory, so they carry one level of indentation.
function functionSource(source, name, indent = '') {
    const match = source.match(new RegExp(`^${indent}function ${name}\\([\\s\\S]*?^${indent}}`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

function loadCreateChatFileButton() {
    const factory = new Function('sbOwnedElements', 'formatChatTimestamp', 'describeChatName', `
        ${functionSource(shellSource, 'createElement')}
        ${functionSource(chatActionsSource, 'createChatFileButton', '    ')}
        return createChatFileButton;
    `);
    return factory(new WeakSet(), () => '2026-11-27', name => name);
}

describe('chat sidebar file button', () => {
    test('renders the message preview and the chat name as text, never as markup', () => {
        const createChatFileButton = loadCreateChatFileButton();
        const preview = '<img src=x onerror="window.__previewRan = true"> hello';
        const fileName = '<b>name</b>';

        const button = createChatFileButton({ fileName, preview, lastMessage: 1, chatItems: 3, fileSize: '1kb' }, '', () => {});
        document.body.append(button);

        expect(button.querySelector('img')).toBeNull();
        expect(button.querySelector('b')).toBeNull();
        expect(button.querySelector('.sb-chat-file-preview').textContent).toBe(preview);
        expect(button.querySelector('.sb-chat-file-head strong').textContent).toBe(fileName);
        expect(button.querySelector('.sb-chat-file-head small').textContent).toBe('2026-11-27');
        expect([...button.querySelectorAll('.sb-chat-file-meta small')].map(node => node.textContent)).toEqual(['3 msg', '1kb']);
        expect(window.__previewRan).toBeUndefined();
    });
});
