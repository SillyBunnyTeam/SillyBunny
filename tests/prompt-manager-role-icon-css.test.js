import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptManagerCss = readFileSync(path.join(repoRoot, 'public', 'css', 'promptmanager.css'), 'utf8').replace(/\r\n/g, '\n');

function getRuleBody(cssSource, selector) {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = cssSource.match(new RegExp(`^\\s*${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`, 'ms'));

    return match?.groups?.body ?? '';
}

describe('prompt manager role icon css', () => {
    test('keeps Font Awesome role icons outside prompt name truncation', () => {
        const promptNameSelector = '#completion_prompt_manager #completion_prompt_manager_list .completion_prompt_manager_prompt_name';
        const truncationRule = getRuleBody(
            promptManagerCss,
            `${promptNameSelector} > a,\n${promptNameSelector} > span[title]:not(.fa-solid)`,
        );

        expect(truncationRule).toContain('min-width: 0;');
        expect(truncationRule).toContain('overflow: hidden;');
        expect(truncationRule).toContain('text-overflow: ellipsis;');
    });
});
