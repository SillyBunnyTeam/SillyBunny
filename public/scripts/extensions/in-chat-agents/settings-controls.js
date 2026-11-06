import { buildSettingsPageModel } from './ui/settings-page-controller.js';

const fields = [
    {
        id: 'connectionProfile', label: 'Default Connection Profile',
        title: 'Which connection profile to use when an agent does not have its own editor profile override. Leave this on the selected Connection Manager profile to follow the active profile.',
        options: [['', 'Use selected connection profile']],
    },
    {
        id: 'companionConnectionProfile', label: 'Companion Connection Profile',
        title: 'Which connection profile Companion agents (trackers, notes) use when they do not have their own editor profile override. Leave empty to share the default above.',
        caption: 'Point this at a cheap, fast model — companions run on every reply.',
        options: [['', 'Use Default Connection Profile']],
    },
    {
        id: 'appendAgentsExecutionMode', label: 'Append Agents Execution',
        title: 'Run append-mode agents in parallel (faster, may hit rate limits) or sequentially (slower, avoids rate limits).',
        caption: 'Sequential runs append-mode agents one after another in Order ascending. Order is shown on each agent card.',
    },
    {
        id: 'companionExecutionMode', label: 'Companion Execution',
        title: 'Run companion agents in parallel (faster) or sequentially (rate-limit friendly), independent of the append agents setting.',
    },
    {
        id: 'companionConcurrent', label: 'Run Companions Alongside Post-Gen Passes',
        title: 'Run companion agents at the same time as post-generation passes instead of after them. Faster, but companions see the reply before post passes edit it.',
    },
    {
        id: 'separateRecentChats', label: 'Separate Agents Between Individual and Group Chats',
        title: 'Keep enabled In-Chat Agents separate between Individual chats and Group chats.',
    },
    {
        id: 'promptTransformShowNotifications', label: 'Allow prompt pass toast notifications',
        title: 'Master switch for prompt pass toasts. Per-agent notification checkboxes still decide which agents can show them.',
    },
    {
        id: 'postMainInterceptShowMessageFirst', label: 'View main LLM output before pre-generation intercept',
        title: 'View main LLM output before pre-generation intercept',
    },
    {
        id: 'helperPrefillMessages', label: 'Helper Prefill Messages',
        caption: 'Use [system], [user], or [assistant] blocks. Text before any header is treated as [assistant].',
        placeholder: '[assistant] Start of helper response\n\n[system] Extra instruction',
    },
    {
        id: 'pathfinderSubmoduleEnabled', label: 'Enable Pathfinder submodule',
        title: 'Enable or disable the built-in Pathfinder submodule without disabling shared In-Chat Agents.',
    },
];

export function createAgentSettingsControls() {
    const store = document.createElement('div');
    store.id = 'ica--settings';
    store.hidden = true;
    const model = buildSettingsPageModel().groups.flatMap(group => group.rows);
    const descriptors = fields.map(field => {
        const id = `ica--${field.id}`;
        const row = model.find(row => row.id === id);
        if (!row) throw new Error(`Unknown Agents setting control: ${id}`);
        const tag = row.kind === 'switch' ? 'input' : row.kind === 'textarea' ? 'textarea' : 'select';
        const input = document.createElement(tag);
        input.id = id;
        input.title = field.title ?? '';
        if (row.kind === 'switch') input.type = 'checkbox';
        else {
            input.className = 'text_pole';
            if (row.kind === 'textarea') {
                input.classList.add('ica--helper-prefill-field');
                input.rows = 4;
                input.placeholder = field.placeholder;
            } else {
                const options = field.options ?? [['parallel', 'Parallel (faster)'], ['sequential', 'Sequential (rate-limit friendly)']];
                for (const [value, label] of options) input.append(new Option(label, value));
            }
        }
        store.append(input);
        return { id, label: field.label, caption: field.caption ?? '', title: field.title ?? '' };
    });
    const importFile = document.createElement('input');
    importFile.id = 'ica--importFile';
    importFile.type = 'file';
    importFile.accept = '.json';
    importFile.hidden = true;
    store.append(importFile);
    return { store, fields: descriptors };
}
