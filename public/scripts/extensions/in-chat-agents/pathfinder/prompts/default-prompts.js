/**
 * Default Prompts - Bundled prompts for the predictive lore pipeline
 */

/** @type {import('./prompt-store.js').PipelinePrompt} */
export const CANDIDATE_SELECTOR_PROMPT = {
    id: 'candidate-selector',
    name: 'Candidate Selector',
    description: 'First-pass selection of potentially relevant lorebook entries based on narrative context',
    version: 1,
    systemPrompt: `You are a predictive lorebook retrieval assistant for a roleplay scenario. Your task is to identify which lorebook entries MIGHT become relevant based on the current narrative flow.

IMPORTANT: Think PREDICTIVELY, not just reactively:
- What characters, locations, or items might APPEAR next?
- What backstory or lore might become relevant based on where the scene is heading?
- What foreshadowing or callbacks might pay off?
- What relationships or conflicts might surface?

Consider:
1. Explicitly mentioned entities (characters, places, items)
2. Implied references or allusions
3. Narrative momentum - where is the scene likely to go?
4. Character relationships that might become relevant
5. World rules or mechanics that might apply
6. Emotional/thematic resonance

Cast a WIDE net - it's better to include marginal candidates than miss important ones. The next stage will filter.

Output a JSON array of entry names/IDs that could be relevant. Include your reasoning briefly.`,

    userPromptTemplate: `## Recent Chat History
{{chat_history}}

## Available Lorebook Entries
{{entry_list}}

Based on the narrative context, which entries might be relevant for what's happening or about to happen? Think about:
- Who/what is directly mentioned or implied
- Where the scene might go next
- What backstory or lore could inform the current situation

Return a JSON array of entry names that should be retrieved. Format:
\`\`\`json
{
  "candidates": ["Entry Name 1", "Entry Name 2", ...],
  "reasoning": "Brief explanation of why these were selected"
}
\`\`\``,

    outputFormat: 'json_object',
    connectionProfile: '',
    settings: {
        maxTokens: 64000,
        temperature: 0.3,
    },
    isDefault: true,
};

/** @type {import('./prompt-store.js').PipelinePrompt} */
export const RELEVANCE_FILTER_PROMPT = {
    id: 'relevance-filter',
    name: 'Relevance Filter',
    description: 'Second-pass filtering to select the most relevant entries from candidates',
    version: 1,
    systemPrompt: `You are a lorebook relevance filter for a roleplay scenario. You receive a list of candidate lorebook entries and must determine which are ACTUALLY relevant to inject into the context.

Your job is to be SELECTIVE. The first pass cast a wide net; you must now filter down to what truly matters for this specific moment.

Consider:
1. Direct relevance - Is this entity/concept actively part of the current scene?
2. Imminent relevance - Will this likely become important in the next few exchanges?
3. Contextual necessity - Does the AI need this information to respond appropriately?
4. Token efficiency - Don't include entries that add little value

REJECT entries that are:
- Only tangentially related
- Background info that won't affect the immediate scene
- Redundant with other selected entries
- Too detailed for the current context

Be ruthless but fair. Aim for the minimum set that provides maximum relevant context.`,

    userPromptTemplate: `## Recent Chat History
{{chat_history}}

## Candidate Entries
{{candidate_entries}}

Review each candidate entry and determine which should be injected as context. Consider:
- Is this directly relevant to the current scene?
- Will the AI need this info to respond well?
- Is this worth the token cost?

Return a JSON array of entry names to include. Format:
\`\`\`json
{
  "selected": ["Entry Name 1", "Entry Name 2", ...],
  "rejected": ["Entry Name 3", ...],
  "reasoning": "Brief explanation of filtering decisions"
}
\`\`\``,

    outputFormat: 'json_object',
    connectionProfile: '',
    settings: {
        maxTokens: 64000,
        temperature: 0.2,
    },
    isDefault: true,
};

/** @type {import('./prompt-store.js').Pipeline} */
export const DEFAULT_PIPELINE = {
    id: 'default',
    name: 'Two-Stage Predictive Retrieval',
    description: 'Candidate selection followed by relevance filtering',
    stages: [
        {
            promptId: 'candidate-selector',
            inputMapping: {
                chat_history: 'source:chat_history',
                entry_list: 'source:entry_names',
            },
            outputKey: 'candidate_ids',
        },
        {
            promptId: 'relevance-filter',
            inputMapping: {
                chat_history: 'source:chat_history',
                candidate_entries: 'prev:candidate_entries',
            },
            outputKey: 'final_ids',
            optional: true,
            skipCondition: 'skipSecondPass',
        },
    ],
    isDefault: true,
};

/** @type {import('./prompt-store.js').Pipeline} */
export const SINGLE_PASS_PIPELINE = {
    id: 'single-pass',
    name: 'Single-Pass Selection',
    description: 'Quick candidate selection without filtering (faster, less precise)',
    stages: [
        {
            promptId: 'candidate-selector',
            inputMapping: {
                chat_history: 'source:chat_history',
                entry_list: 'source:entry_names',
            },
            outputKey: 'final_ids',
        },
    ],
    isDefault: true,
};

/**
 * Get all default prompts
 * @returns {Record<string, import('./prompt-store.js').PipelinePrompt>}
 */
export function getDefaultPrompts() {
    return {
        [CANDIDATE_SELECTOR_PROMPT.id]: CANDIDATE_SELECTOR_PROMPT,
        [RELEVANCE_FILTER_PROMPT.id]: RELEVANCE_FILTER_PROMPT,
    };
}

/**
 * Get all default pipelines
 * @returns {Record<string, import('./prompt-store.js').Pipeline>}
 */
export function getDefaultPipelines() {
    return {
        [DEFAULT_PIPELINE.id]: DEFAULT_PIPELINE,
        [SINGLE_PASS_PIPELINE.id]: SINGLE_PASS_PIPELINE,
    };
}
