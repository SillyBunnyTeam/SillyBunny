import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

/**
 * @param {string} file Script name under public/scripts
 * @param {string} name Top-level declaration to take from it
 * @returns {string} Source of that declaration
 */
function getDeclarationSource(file, name) {
    const source = readFileSync(new URL(`../public/scripts/${file}.js`, import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const node = ast.body.map(node => node.declaration ?? node)
        .find(node => node.id?.name === name || node.declarations?.some(item => item.id.name === name));
    if (!node) throw new Error(`Missing declaration: ${file}.${name}`);
    return source.slice(node.start, node.end);
}

const context = vm.createContext({ CONNECT_API_MAP: {}, UNIQUE_APIS: [] });
vm.runInContext(getDeclarationSource('textgen-settings', 'textgen_types'), context);
vm.runInContext(getDeclarationSource('openai', 'chat_completion_sources'), context);
vm.runInContext(getDeclarationSource('slash-commands', 'setupConnectAPIMap'), context);
vm.runInContext('setupConnectAPIMap()', context);

describe('KoboldCpp API names', () => {
    test.each(['koboldcpp', 'kcpp'])('/api %s keeps selecting the KoboldCpp Text Completion API', (name) => {
        expect(context.CONNECT_API_MAP[name]).toMatchObject({ selected: 'textgenerationwebui', type: 'koboldcpp' });
    });

    test.each(['koboldcpp-chat', 'kcpp-chat'])('/api %s selects the KoboldCpp Chat Completion source', (name) => {
        expect(context.CONNECT_API_MAP[name]).toEqual({ selected: 'openai', button: '#api_button_openai', source: 'koboldcpp' });
    });

    test('/api reports koboldcpp-chat, the first name for the KoboldCpp Chat Completion source', () => {
        const [name] = Object.entries(context.CONNECT_API_MAP).find(([, config]) => config.source === 'koboldcpp');
        expect(name).toBe('koboldcpp-chat');
    });
});
