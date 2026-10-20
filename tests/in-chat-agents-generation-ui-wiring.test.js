import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'index.js'), 'utf8');
const publicIndexSource = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const companionUiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'companion', 'companion-ui.js'), 'utf8');
const agentRunnerSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'agent-runner.js'), 'utf8');
const extensionStyleSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'style.css'), 'utf8');
const settingsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'settings-controls.js'), 'utf8');
const coreScriptSource = readFileSync(path.join(repoRoot, 'public', 'script.js'), 'utf8');
const listSource = readFileSync(path.join(repoRoot, 'public/scripts/extensions/in-chat-agents/ui/agent-list.js'), 'utf8');
const modelSource = readFileSync(path.join(repoRoot, 'public/scripts/extensions/in-chat-agents/ui/agent-list-model.js'), 'utf8');
const tabsSource = readFileSync(path.join(repoRoot, 'public/scripts/sillybunny-tabs.js'), 'utf8');
const editorSource = readFileSync(path.join(repoRoot, 'public/scripts/extensions/in-chat-agents/ui/agent-editor.js'), 'utf8');
const controllerSource = readFileSync(path.join(repoRoot, 'public/scripts/extensions/in-chat-agents/ui/agent-editor-controller.js'), 'utf8');
const editorModelSource = readFileSync(path.join(repoRoot, 'public/scripts/extensions/in-chat-agents/ui/agent-editor-model.js'), 'utf8');
const dialogsSource = readFileSync(path.join(repoRoot, 'public/scripts/extensions/in-chat-agents/ui/agent-editor-dialogs.js'), 'utf8');

function getFunctionSource(name) {
    const marker = `function ${name}(`;
    const start = indexSource.indexOf(marker);

    expect(start).toBeGreaterThanOrEqual(0);

    const bodyStart = indexSource.indexOf(') {', start) + 2;
    let depth = 0;

    for (let index = bodyStart; index < indexSource.length; index++) {
        const char = indexSource[index];
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return indexSource.slice(start, index + 1);
            }
        }
    }

    throw new Error(`Unable to find function source for ${name}`);
}

describe('in-chat agents generation UI wiring', () => {
    test('uses the shared send-button lifecycle for agent activity', () => {
        const updateSource = getFunctionSource('updateAgentGenerationSendControls');

        expect(indexSource).toContain('activateSendButtons');
        expect(indexSource).toContain('deactivateSendButtons');
        expect(updateSource).toContain('deactivateSendButtons({ markBodyGenerating: false });');
        expect(updateSource).toContain('if (!is_send_press && !is_group_generating)');
        expect(updateSource).toContain('activateSendButtons();');
    });

    test('subscribes agent state changes and routes send-bar stop clicks to agent cancel', () => {
        expect(indexSource).toContain('onAgentGenerationStateChanged(refreshGenerationUi);');
        expect(indexSource).toContain('$(document).on(\'click\', \'#mes_stop\'');
        expect(indexSource).toContain('cancelAgentGeneration();');
    });

    test('refreshes generation UI from core events without forwarding payloads', () => {
        expect(indexSource).toContain('event_types.GENERATION_STARTED');
        expect(indexSource).toContain('event_types.GENERATION_ENDED');
        expect(indexSource).toContain('event_types.GENERATION_STOPPED');
        expect(indexSource).toContain('eventSource.on(eventName, () => refreshGenerationUi());');
        expect(indexSource).not.toContain('eventSource.on(eventName, refreshGenerationUi);');
    });

    test('wires companion message cards and actions into chat rendering', () => {
        expect(publicIndexSource).toContain('mes_run_companions');
        expect(companionUiSource).toContain('renderCompanionResultsForMessage');
        expect(companionUiSource).toContain('ica--companion-ledger');
        expect(companionUiSource).toContain('data-action="regenerate"');
        expect(companionUiSource).toContain('updateCompanionResult(message, agentId');
        expect(extensionStyleSource).toContain('.ica--companion-card');
        expect(extensionStyleSource).toContain('.mes_run_companions--running');
    });

    test('wires companion AI Maker in the editor', () => {
        expect(editorSource).toContain('headerAction(output, t`AI Maker…`');
        expect(editorSource).toContain('apply(await helpers.maker(fields()))');
        expect(dialogsSource).toContain('await services.generateCompanionKitWithAI(');
        expect(dialogsSource).toContain('if (!await show(preview)) return null;');
    });

    test('passes custom tracker regeneration instructions into the LLM prompt', () => {
        const source = getFunctionSource('generateTrackerKitWithAI');

        expect(source).toContain('extraInstructions = \'\'');
        expect(source).toContain('Extra custom instructions for this generation:');
        expect(source).toContain('extraInstructions || \'(none)\'');
    });

    test('wires custom tracker HTML preview and regeneration controls', () => {
        const previewSource = getFunctionSource('buildTrackerHtmlPreviewNode');
        const popupSource = getFunctionSource('buildTrackerPreviewPopupContent');

        expect(previewSource).toContain('applyRegexScriptList');
        expect(previewSource).toContain('AGENT_REGEX_PLACEMENT.AI_OUTPUT');
        expect(previewSource).toContain('ica--tracker-preview-frame');
        expect(popupSource).toContain('ica--tracker-builder-extra-instructions');
        expect(dialogsSource).toContain('text: t`Regenerate`');
        expect(dialogsSource).toContain('$(popup.content).empty().append(services.buildTrackerPreviewPopupContent(');
        expect(dialogsSource).toMatch(/extraInstructions,?\s*}\);/);
        expect(extensionStyleSource).toContain('.ica--tracker-preview-frame');
    });

    test('keeps companion settings labels clear and aligned', () => {
        expect(editorSource).toContain('createSwitchRow(');
        expect(editorSource).toContain('createPrefGroup(');
        expect(editorSource).toContain('Companion · Coordination');
        expect(editorSource).toContain('toggle(coordination, \'companion.batch\', companionCopy.batch)');
        expect(editorSource).toContain('path === \'companion.batchAgentIds\'');
        expect(getFunctionSource('getAgentEditorCompanionOptions')).toContain('isAgentEnabledForCurrentScope(candidate)');
        expect(editorSource).toContain('toggle(coordination, \'companion.sendContextToCompanions\', t`Send Context`)');
        expect(editorSource).toContain('select(coordination, \'companion.contextRecipientAgentIds\', t`Recipients`');
        expect(editorSource).toContain('select(coordination, \'companion.dependencies\', t`Re-run After`');
        expect(editorSource).toContain('toggle(coordination, \'companion.waitForDependencies\', t`Wait`)');
        expect(editorSource).toContain('Companion · Chat History');
        expect(editorSource).toContain('toggle(history, \'companion.includeInChatHistory\', t`Keep in Chat History`)');
        expect(editorSource).toContain('spin(history, \'companion.chatHistoryDepth\', t`Notes to Keep`)');
        expect(controllerSource).toContain('await services.syncCompanionChatHistoryConfig(saved)');
        expect(editorSource).toContain('toggle(history, \'companion.includeAllChatHistory\', t`Keep All`)');
        expect(editorSource).toContain('toggle(history, \'companion.keepInChatHistoryWhenHostHidden\', t`Keep When Hidden`)');
        expect(editorSource).not.toContain('Cannot be turned on with');
        expect(editorSource).not.toContain('Batch with compatible companions');
    });

    test('persists companion context-send and dependency delay toggles', () => {
        expect(editorSource).toContain('toggle(coordination, \'companion.sendContextToCompanions\'');
        expect(editorSource).toContain('select(coordination, \'companion.contextRecipientAgentIds\'');
        expect(editorSource).toContain('checked: read(initial, path)');
        expect(editorSource).toContain('onChange: value => update(path, value)');
        expect(editorSource).toContain('[...control.selectedOptions].map(option => option.value)');
        expect(editorSource).toContain('view.setValue?.(');
        expect(editorSource).toContain('toggle(coordination, \'companion.waitForDependencies\'');
        expect(controllerSource).toContain('parent[key] = structuredClone(value);');
        expect(editorModelSource).toContain('const fields = createAgentEditorState(state.fields).fields;');
    });

    test('persists companion chat history and projects it into prompt-only messages', () => {
        expect(editorSource).toContain('checked: read(initial, path)');
        expect(editorSource).toContain('toggle(history, \'companion.includeInChatHistory\'');
        expect(editorSource).toContain('spin(history, \'companion.chatHistoryDepth\'');
        expect(editorSource).toContain('toggle(history, \'companion.includeAllChatHistory\'');
        expect(editorSource).toContain('toggle(history, \'companion.keepInChatHistoryWhenHostHidden\'');
        expect(editorSource).toContain('onChange: value => update(path, value)');
        expect(editorModelSource).toContain('parseNumbers(fields);');
        expect(controllerSource).toContain('serializeAgentEditorState(original, receipt.snapshot');
        expect(editorSource).toContain('view.setValue?.(');
        expect(editorModelSource).toContain('\'companion.chatHistoryDepth\': f.companion.includeAllChatHistory');
        expect(controllerSource).toContain('const changed = await services.syncCompanionChatHistoryConfig(saved)');
        expect(controllerSource).toContain('if (changed > 0) services.saveChatDebounced({ deferBackup: false });');
        expect(coreScriptSource).toContain('const companionRewriteTarget = companionHistoryTarget');
        expect(coreScriptSource).toContain('const companionFeedbackTarget = companionHistoryTarget');
        expect(coreScriptSource).toContain('companionHistoryTarget: companionFeedbackTarget');
        expect(agentRunnerSource).toContain('companionRuntime?.stripAuxiliaryTrackerEchoes?.(message.mes, undefined, activeAgents)');
        expect(agentRunnerSource).toContain('await refreshMessageAfterMutation(messageIndex, message, { deferBackup: true });');
        expect(coreScriptSource).toContain('isContinue || type === \'swipe\' || type === \'regenerate\' ? lastMessage : null');
        expect(coreScriptSource).toContain('message !== companionRewriteTarget');
        expect(coreScriptSource).toContain('!message.extra?.[IGNORE_SYMBOL]');
        expect(coreScriptSource).toContain(').filter(message => !message.extra?.[IGNORE_SYMBOL]);');
        expect(coreScriptSource).toContain('consolidateCompanionChatHistory(companionCandidateMessages, companionChatHistory');
        expect(coreScriptSource).toContain('companionRewriteTarget && !chat.includes(companionRewriteTarget)');
        expect(coreScriptSource).toContain('policyMessages: companionPolicyMessages');
        expect(coreScriptSource.match(/companionHistoryTarget: companionRewriteTarget/g)).toHaveLength(2);
        expect(coreScriptSource).toContain('hasCompanionChatHistoryForHiddenHost(x)');
        expect(coreScriptSource).toContain('consolidateCompanionChatHistory(companionCandidateMessages, companionChatHistory');
        expect(coreScriptSource).toContain('chatItem === consolidatedCompanionHistoryHost');
        expect(coreScriptSource).toContain('original: sourceMessage.is_system ? \'\' : sourceMessage.mes');
        expect(coreScriptSource).toContain('const contextSourceMessage = hiddenCompanionHistory ? \'\' : originalMessage');
        expect(coreScriptSource).toContain('const worldInfoContextSourceMessage = hiddenCompanionHistory ? \'\' : worldInfoSourceMessage');
        expect(coreScriptSource).toContain('const consolidatedContextMessage = [contextMessage, ...retainedContributions.map(contribution => contribution.content)]');
        expect(coreScriptSource).toContain('const fileContent = hiddenCompanionHistory ? \'\' : await appendFileContent(chatItem, \'\');');
        expect(coreScriptSource).toContain('extra: hiddenCompanionHistory ? {} : chatItem.extra');
        expect(coreScriptSource).toContain('is_system: hiddenCompanionHistory ? false : chatItem.is_system');
        expect(coreScriptSource).toContain('getRegexedString(worldInfoContextSourceMessage, regexType, options)');
        expect(dialogsSource).toContain('includeInChatHistory: agent.companion.includeInChatHistory');
        expect(dialogsSource).toContain('chatHistoryDepth: agent.companion.chatHistoryDepth');
        expect(dialogsSource).toContain('includeAllChatHistory: agent.companion.includeAllChatHistory');
        expect(dialogsSource).toContain('keepInChatHistoryWhenHostHidden: agent.companion.keepInChatHistoryWhenHostHidden');
        expect(editorSource).toContain('sb-persona-entry-body');
        expect(listSource).toContain('css/sillybunny-persona-detail.css');
    });

    test('mounts shared entity rows with touch-sized grips instead of the old list host', () => {
        expect(tabsSource).toContain('const controller = mountAgentsPanel(column);');
        expect(tabsSource).not.toContain('id: \'in_chat_agents_container\'');
        expect(listSource).toContain('createEntityRow(');
        expect(listSource).toContain('reconcileRows(');
        expect(listSource).toContain('bindSortable(');
        expect(extensionStyleSource).toMatch(/\.ica-agents-editor \.ica-agent-grip[^{]*\{\s*min-width: 44px;\s*min-height: 44px;/);
    });

    test('lists all enabled side companions in batch selector regardless of compatibility', () => {
        const source = getFunctionSource('getAgentEditorCompanionOptions');
        expect(source).not.toContain('getCompanionBatchCompatibilityKey');
        expect(source).toContain('isAgentEnabledForCurrentScope(candidate)');
        expect(source).toContain('isCompanionAgent(candidate)');
        expect(source).toContain('getCompanionReferenceIds(candidate)');
    });

    test('selects companion links by saved id or source template id', () => {
        const source = getFunctionSource('getAgentEditorCompanionOptions');
        expect(source).toContain('getCompanionReferenceIds(candidate).map(value => value.toLowerCase())');
        expect(source).toContain('selectedIds.filter(value => references.has(value.toLowerCase()))');
        for (const field of ['batchAgentIds', 'contextRecipientAgentIds', 'dependencies']) {
            expect(editorSource).toContain(`companions('companion.${field}')`);
        }
    });

    test('migrates Level Up and User-based Stats context links once', () => {
        const migrationSource = getFunctionSource('migrateLevelUpStatsContextLinks');
        const defaultSource = getFunctionSource('applyLevelUpStatsContextLinkDefault');

        expect(indexSource).toContain('LEVEL_UP_STATS_CONTEXT_LINKS_VERSION');
        expect(indexSource).toContain('LEVEL_UP_COMPANION_TEMPLATE_ID');
        expect(indexSource).toContain('USER_BASED_STATS_TEMPLATE_ID');
        expect(defaultSource).toContain('sendContextToCompanions: true');
        expect(defaultSource).toContain('contextRecipientAgentIds: recipientIds');
        expect(defaultSource).toContain('dependencies: dependencyIds');
        expect(defaultSource).toContain('waitForDependencies');
        expect(indexSource).toContain('const LEVEL_UP_STATS_CONTEXT_LINKS_VERSION = 2;');
        expect(migrationSource).toContain('levelUpStatsContextLinksVersion');
        expect(indexSource).toContain('await migrateLevelUpStatsContextLinks();');
    });

    test('targets inline and companion tracker fixes independently', () => {
        const visibilitySource = getFunctionSource('updateFixTrackersButtonVisibility');
        const runSource = getFunctionSource('runTrackerFixFromButton');
        const globalButtonSource = getFunctionSource('fixTrackersFromList');

        expect(visibilitySource).toContain('hasInlineCandidates');
        expect(visibilitySource).toContain('hasCompanionCandidates');
        expect(visibilitySource).toContain('const isAssistantMessage = isNonSystemMessage');
        expect(visibilitySource).toContain('(hasInlineCandidates && isAssistantMessage)');
        expect(visibilitySource).toContain('(hasCompanionCandidates && isNonSystemMessage)');
        expect(runSource).toContain('hasRunnableInlineTrackerAgents()');
        expect(runSource).toContain('hasRunnableCompanionTrackerAgents()');
        expect(runSource).toContain('const cancelRevision = getAgentGenerationCancelRevision();');
        expect(runSource).toContain('const fixChatId = getCurrentChatId();');
        expect(runSource).toContain('isFixContextCurrent()');
        expect(runSource).toContain('runTrackerFixOnMessage(inlineMessageIndex, { cancelRevision })');
        expect(runSource).toContain('runTrackerCompanionsOnMessage(companionMessageIndex, { cancelRevision })');
        expect(runSource).toContain('No assistant reply selected to fix trackers on.');
        expect(globalButtonSource).toContain('const inlineMessageIndex = getLastAssistantMessageIndex();');
        expect(globalButtonSource).toContain('const companionMessageIndex = getLatestValidCompanionMessageIndex();');
        expect(globalButtonSource).toContain('{ inlineMessageIndex, companionMessageIndex }');
    });

    test('populates companion dependency selector during editor setup', () => {
        expect(listSource).toContain('mountAgentDetail(');
        for (const field of ['companion.batchAgentIds', 'companion.contextRecipientAgentIds', 'companion.dependencies']) {
            expect(editorSource).toContain(`select(coordination, '${field}'`);
        }
        expect(getFunctionSource('openEditor')).toContain('ui.openAgentDetail(');
        expect(getFunctionSource('openEditor')).not.toContain('renderExtensionTemplateAsync(MODULE_NAME, \'editor\')');
    });

    test('groups companion execution separately and registers the initialized adapter', () => {
        expect(modelSource).toContain('const STAGES = [\'pre\', \'both\', \'post\', \'companion\'];');
        expect(modelSource).toContain('agent.execution === \'companion\' || agent.category === \'companion\'');
        expect(indexSource).toContain('await registerAgentListUi(settingsStore, settingsFields);');
        expect(getFunctionSource('registerAgentListUi')).toContain('ui.registerAgentsPanelAdapter({');
        expect(listSource).not.toContain('from \'../index.js\'');
    });

    test('uses shared selection UI while retaining scoped enablement and customization at the action seam', () => {
        expect(listSource).toContain('createSelectionMode(');
        expect(listSource).toContain('t`Select`');
        expect(listSource).toContain('getAllKeys: () => getAgentSelectionKeys(model)');
        expect(getFunctionSource('performAgentBulkAction')).toContain('lockBundledAgentCustomization(agent);');
        const source = getFunctionSource('setAgentListEntryEnabled');
        expect(source).toContain('setAgentEnabledForCurrentScope(agent, enabled);');
        expect(source).toContain('persistExtensionState();');
        expect(getFunctionSource('performAgentListAction')).toContain('lockBundledAgentCustomization(agent);');
        expect(settingsSource).toContain('createAgentSettingsControls');
        expect(settingsSource).toContain('ica--importFile');
    });

    test('allows manual agent application to multiple selected targets', () => {
        const pickerSource = getFunctionSource('pickManualAgentRunTargets');
        const handlerSource = getFunctionSource('performAgentListAction');

        expect(pickerSource).toContain('type="checkbox" name="ica--run-target"');
        expect(pickerSource).not.toContain('type="radio" name="ica--run-target"');
        expect(pickerSource).toContain('picker.find(\'input[name="ica--run-target"]:checked\').map((_, input) => String(input.value)).get()');
        expect(pickerSource).toContain('return selected.flatMap(value => {');
        expect(handlerSource).toContain('targets = await pickManualAgentRunTargets(entry.agent);');
        expect(handlerSource).toContain('await Promise.all(targets.map(target => runAgentOnTarget(agent.id, target)));');
    });

    test('unused manual runs choose targets before materialisation; editor open stays read-only', () => {
        const source = getFunctionSource('performAgentListAction');
        expect(source.indexOf('await pickManualAgentRunTargets(entry.agent)')).toBeLessThan(source.indexOf('await materialise('));
        expect(source).toContain('if (!targets?.length) return;');
        expect(getFunctionSource('openAgentListEntry')).not.toContain('await materialise(');
        expect(getFunctionSource('openEditor')).not.toContain('await materialise(');
        expect(controllerSource).toContain('await services.materialise(materialiseTemplateId, { edits: candidate })');
        expect(controllerSource.indexOf('validateAgentEditorState(receipt.snapshot)')).toBeLessThan(controllerSource.indexOf('await services.materialise('));
    });

    // Inline cards deliberately have no editor hook: opening agent settings from a chat message
    // would be a Layer 1 config entry point and a nested modal chain.
    test('does not wire inline Companion cards to the shared editor', () => {
        expect(indexSource).toContain('import { initCompanionCardUi, updateCompanionButtonVisibility } from \'./companion/companion-ui.js\';');
        expect(indexSource).not.toContain('configureCompanionCardUi');
    });

    test('allows the manual reply target to expand to an assistant message range', () => {
        const parserSource = getFunctionSource('getManualAgentRunMessageIndices');
        const pickerSource = getFunctionSource('pickManualAgentRunTargets');

        expect(parserSource).toContain('range.split(\',\')');
        expect(parserSource).toContain('!message.is_user && !message.is_system');
        expect(parserSource).toContain('return [...indexes].sort((a, b) => a - b);');
        expect(pickerSource).toContain('ica--run-target-message-range');
        expect(pickerSource).toContain('Last assistant reply #${lastAssistantIndex}');
        expect(pickerSource).toContain('getManualAgentRunMessageIndices(');
        expect(pickerSource).toContain('return selected.flatMap(value => {');
        expect(extensionStyleSource).toContain('.ica--run-target-range');
    });
});
