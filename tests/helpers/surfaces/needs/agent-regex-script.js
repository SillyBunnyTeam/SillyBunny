/**
 * One saved in-chat agent with two regex scripts, written through `/api/in-chat-agents/save` as the editor saves it, so
 * that the Regex Scripts section of the agent editor has rows whose menus offer Move Up and Move Down. See `index.js`
 * for the shape of a need module.
 */

import { agentFixture } from '../../../fixtures/in-chat-agents-editor.js';
import { readSettingsAnswer } from '../need-kit.js';

export const fixture = Object.freeze({
    agent: Object.freeze({ id: 'audit-agent-regex', name: 'Audit Regex Agent' }),
    scripts: Object.freeze(['Audit Regex First', 'Audit Regex Second']),
});

function buildAgent() {
    const script = (id, scriptName, findRegex, replaceString) => ({
        id, scriptName, findRegex, replaceString, trimStrings: [], placement: [2], disabled: false, markdownOnly: true,
        promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null,
    });
    return agentFixture({
        id: fixture.agent.id,
        name: fixture.agent.name,
        description: 'An agent with regex scripts for the audit.',
        author: 'Audit',
        tags: ['audit'],
        connectionProfile: '',
        modelOverride: '',
        prompt: 'Rewrite the audit notes when asked.',
        enabled: true,
        regexScripts: [
            script('audit-agent-regex-1', fixture.scripts[0], '/audit-alpha/g', 'audit-beta'),
            script('audit-agent-regex-2', fixture.scripts[1], '/audit-gamma/g', 'audit-delta'),
        ],
    });
}

export default {
    async exists(api) {
        const saved = (await readSettingsAnswer(api)).inChatAgents ?? [];
        return saved.some(candidate => candidate.id === fixture.agent.id);
    },
    async seed({ post }) {
        await post('/api/in-chat-agents/save', { data: buildAgent() });
        return `agent ${fixture.agent.id}`;
    },
};
