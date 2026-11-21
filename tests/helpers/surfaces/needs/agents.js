/**
 * Three saved in-chat agents, written through `/api/in-chat-agents/save` as the editor saves them, and delivered to the app
 * in the `inChatAgents` list of the settings answer: a tracker built from a bundled tracker template with a long prompt, a
 * tool agent, and a disabled agent. See `index.js` for the shape of a need module.
 */

import { readFileSync } from 'node:fs';
import { agentFixture, toolFixture } from '../../../fixtures/in-chat-agents-editor.js';
import { readSettingsAnswer } from '../need-kit.js';

const TEMPLATE_ID = 'the-census';
const template = JSON.parse(readFileSync(new URL(`../../../../public/scripts/extensions/in-chat-agents/templates/${TEMPLATE_ID}.json`, import.meta.url), 'utf8'));

/** The three agents by role; `trackerTemplateId` is the bundled template that the tracker was built from. */
export const fixture = Object.freeze({
    trackerTemplateId: template.id,
    tracker: Object.freeze({ id: 'audit-agent-tracker', name: template.name }),
    tool: Object.freeze({ id: 'audit-agent-tool', name: 'Audit Search Tool' }),
    disabled: Object.freeze({ id: 'audit-agent-disabled', name: 'Audit Disabled Agent' }),
});

function buildAgents() {
    const common = { connectionProfile: '', modelOverride: '', author: 'Audit', tags: ['audit'] };
    return [
        agentFixture({
            ...common,
            id: fixture.tracker.id,
            name: template.name,
            description: template.description,
            category: 'tracker',
            sourceTemplateId: template.id,
            prompt: template.prompt,
            phase: template.phase,
            tags: template.tags,
            injection: template.injection,
            postProcess: template.postProcess,
            conditions: template.conditions,
            enabled: true,
        }),
        agentFixture({
            ...common, id: fixture.tool.id, name: fixture.tool.name, description: 'A tool agent for the audit.', category: 'tool',
            prompt: 'Search the audit notes when asked.', tools: [toolFixture()], enabled: true,
        }),
        agentFixture({
            ...common, id: fixture.disabled.id, name: fixture.disabled.name, description: 'An agent that is switched off.',
            prompt: 'This agent never runs.', enabled: false,
        }),
    ];
}

export default {
    async exists(api) {
        const saved = (await readSettingsAnswer(api)).inChatAgents ?? [];
        return buildAgents().every(agent => saved.some(candidate => candidate.id === agent.id));
    },
    async seed({ post }) {
        for (const agent of buildAgents()) {
            await post('/api/in-chat-agents/save', { data: agent });
        }
        return `agents ${buildAgents().map(agent => agent.id).join(', ')}`;
    },
};
