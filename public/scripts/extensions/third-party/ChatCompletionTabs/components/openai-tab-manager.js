/**
 * OpenAI Settings Tab Manager (Refactored)
 * When using the Chat Completion API, add separate tabs for Parameters and Prompt.
 */

// Import required functions
import { main_api } from '../../../../../script.js';
import { oai_settings } from '../../../../openai.js';
import { TabManager } from './tab-manager.js';

export class OpenAITabManager {
    constructor() {
        this.tabManager = new TabManager({
            containerSelector: '#left-nav-panel #openai_api-presets',
            insertAfterSelector: '#left-nav-panel #openai_api-presets > div',
            tabPrefix: 'openai-tab',
            activeTabStorageKey: 'ChatCompletionTabs.openai.activeTab',
            defaultTab: 'parameters',
            className: 'openai-tab',
            tabs: {
                parameters: {
                    label: 'Parameters',
                    icon: 'fa-solid fa-vial',
                    contentSelectors: [
                        '#left-nav-panel #sb-openai-budget',
                        '#left-nav-panel #sb-openai-output',
                        '#left-nav-panel #sb-openai-advanced',
                    ],
                },
                prompts: {
                    label: 'Prompts',
                    icon: 'fa-solid fa-file-edit',
                    contentSelectors: [
                        '#left-nav-panel #sb-openai-prompt-manager',
                        '#left-nav-panel .range-block:has(> #completion_prompt_manager)',
                    ],
                },
            },
            checkCondition: () => {
                // SillyBunny's unified Prompting page owns these groups and keeps them in one scroll flow.
                if (document.querySelector('.sb-prompting-panel #ai_response_configuration')) {
                    return false;
                }
                return typeof main_api !== 'undefined' &&
                       main_api === 'openai' &&
                       typeof oai_settings !== 'undefined' &&
                       document.querySelector('#left-nav-panel') !== null &&
                       document.querySelector('#left-nav-panel #sb-openai-budget') !== null;
            },
        });

        this.enabled = true;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        this.tabManager.setEnabled(enabled);
    }

    refreshTabs() {
        this.tabManager.refreshTabs();
    }

    // Backward compatibility methods
    get activeTab() {
        return this.tabManager.activeTab;
    }

    get isTabsCreated() {
        return this.tabManager.isTabsCreated;
    }
}
