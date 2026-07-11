import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'index.js'), 'utf8');
const publicIndexSource = readFileSync(path.join(repoRoot, 'public', 'index.html'), 'utf8');
const companionUiSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'companion', 'companion-ui.js'), 'utf8');
const extensionStyleSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'style.css'), 'utf8');
const editorTemplateSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'editor.html'), 'utf8');
const settingsSource = readFileSync(path.join(repoRoot, 'public', 'scripts', 'extensions', 'in-chat-agents', 'settings.html'), 'utf8');

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
        expect(editorTemplateSource).toContain('ica--editor-companion-maker');
        expect(editorTemplateSource).toContain('AI Maker');
        expect(indexSource).toContain('generateCompanionKitWithAI');
        expect(indexSource).toContain('Applied generated companion. Review and save when ready.');
    });

    test('passes custom tracker regeneration instructions into the LLM prompt', () => {
        const source = getFunctionSource('generateTrackerKitWithAI');

        expect(source).toContain("extraInstructions = ''");
        expect(source).toContain('Extra custom instructions for this generation:');
        expect(source).toContain("extraInstructions || '(none)'");
    });

    test('wires custom tracker HTML preview and regeneration controls', () => {
        const previewSource = getFunctionSource('buildTrackerHtmlPreviewNode');
        const popupSource = getFunctionSource('buildTrackerPreviewPopupContent');

        expect(previewSource).toContain('applyRegexScriptList');
        expect(previewSource).toContain('AGENT_REGEX_PLACEMENT.AI_OUTPUT');
        expect(previewSource).toContain('ica--tracker-preview-frame');
        expect(popupSource).toContain('ica--tracker-builder-extra-instructions');
        expect(indexSource).toContain("text: 'Regenerate'");
        expect(indexSource).toContain('trackerPreviewPopup.content.innerHTML');
        expect(extensionStyleSource).toContain('.ica--tracker-preview-frame');
    });

    test('keeps companion settings labels clear and aligned', () => {
        expect(editorTemplateSource).toContain('ica--companion-core-grid');
        expect(extensionStyleSource).toContain('.ica--companion-core-grid');
        expect(extensionStyleSource).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
        expect(editorTemplateSource).toContain('Run selected companions in one request');
        expect(editorTemplateSource).toContain('Batch With Enabled Companions');
        expect(editorTemplateSource).toContain('Turn it on to fetch currently enabled side companions');
        expect(editorTemplateSource).toContain('ica--editor-companion-sendContextToCompanions');
        expect(editorTemplateSource).toContain('Send context to the following Companion Agents before generation');
        expect(editorTemplateSource).toContain('ica--editor-companion-contextRecipientAgentIds');
        expect(editorTemplateSource).toContain('ica--editor-companion-waitForDependencies');
        expect(editorTemplateSource).toContain('Delay until selected companions finish');
        expect(editorTemplateSource).not.toContain('Batch with compatible companions');
    });

    test('persists companion context-send and dependency delay toggles', () => {
        const readSource = getFunctionSource('readCompanionConfigFromEditor');
        const writeSource = getFunctionSource('writeCompanionConfigToEditor');

        expect(indexSource).toContain("#ica--editor-companion-sendContextToCompanions");
        expect(indexSource).toContain("#ica--editor-companion-contextRecipientAgentIds");
        expect(readSource).toContain("sendContextToCompanions: root.find('#ica--editor-companion-sendContextToCompanions').prop('checked')");
        expect(readSource).toContain("contextRecipientAgentIds: normalizeCompanionBatchAgentIds(root.find('#ica--editor-companion-contextRecipientAgentIds').val())");
        expect(writeSource).toContain("editorEl.find('#ica--editor-companion-sendContextToCompanions').prop('checked', nextCompanion.sendContextToCompanions);");
        expect(writeSource).toContain('updateCompanionContextRecipientOptions();');
        expect(indexSource).toContain("#ica--editor-companion-waitForDependencies");
        expect(readSource).toContain("waitForDependencies: root.find('#ica--editor-companion-waitForDependencies').prop('checked')");
        expect(writeSource).toContain("editorEl.find('#ica--editor-companion-waitForDependencies').prop('checked', nextCompanion.waitForDependencies);");
    });

    test('lists all enabled side companions in batch selector regardless of compatibility', () => {
        const source = getFunctionSource('getCompanionBatchOptionsForAgent');
        expect(source).not.toContain('getCompanionBatchCompatibilityKey');
        expect(source).toContain('isAgentEnabledForCurrentScope(candidate)');
        expect(source).toContain('isCompanionAgent(candidate)');
        expect(source).toContain('referenceIds: getCompanionReferenceIds(candidate)');
    });

    test('selects companion links by saved id or source template id', () => {
        const batchSource = getFunctionSource('updateCompanionBatchAgentOptions');
        const contextRecipientSource = getFunctionSource('updateCompanionContextRecipientOptions');
        const dependencySource = getFunctionSource('updateCompanionDependencyOptions');

        for (const source of [batchSource, contextRecipientSource, dependencySource]) {
            expect(source).toContain('options.flatMap(option => option.referenceIds)');
            expect(source).toContain('option.referenceIds.some(id => selectedKeys.has(id.toLowerCase()))');
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

    test('targets tracker fixes only at assistant messages while allowing connected companions on user messages', () => {
        const visibilitySource = getFunctionSource('updateFixTrackersButtonVisibility');
        const runSource = getFunctionSource('runTrackerFixFromButton');
        const globalButtonStart = indexSource.indexOf("$('#ica--fixTrackers').on('click'");
        const globalButtonEnd = indexSource.indexOf("$('#ica--templatesCallout')", globalButtonStart);
        const globalButtonSource = indexSource.slice(globalButtonStart, globalButtonEnd);

        expect(visibilitySource).toContain('hasTrackerCandidates');
        expect(visibilitySource).toContain('hasConnectedCandidates');
        expect(visibilitySource).toContain('const isAssistantMessage = isNonSystemMessage');
        expect(visibilitySource).toContain('(hasTrackerCandidates && isAssistantMessage)');
        expect(visibilitySource).toContain('(hasConnectedCandidates && isNonSystemMessage)');
        expect(runSource).toContain('canRunTrackersOnMessage');
        expect(runSource).toContain('hasTrackers && canRunTrackersOnMessage');
        expect(runSource).toContain('No assistant reply selected to fix trackers on.');
        expect(globalButtonSource).toContain('hasConnectedCompanionAgents()');
        expect(globalButtonSource).toContain('getLastAssistantMessageIndex()');
    });

    test('populates companion dependency selector during editor setup', () => {
        const source = getFunctionSource('openEditor');
        const setupStart = source.indexOf('updateTrackerBuilderVisibility();');
        const setupEnd = source.indexOf('// Show/hide sections based on phase');
        const setupSource = source.slice(setupStart, setupEnd);

        expect(editorTemplateSource).toContain('ica--editor-companion-dependencies');
        expect(setupSource).toContain('updateCompanionBatchAgentOptions();');
        expect(setupSource).toContain('updateCompanionContextRecipientOptions();');
        expect(setupSource).toContain('updateCompanionDependencyOptions();');
        expect(setupSource.indexOf('updateCompanionContextRecipientOptions();')).toBeGreaterThan(setupSource.indexOf('updateCompanionBatchAgentOptions();'));
        expect(setupSource.indexOf('updateCompanionDependencyOptions();')).toBeGreaterThan(setupSource.indexOf('updateCompanionContextRecipientOptions();'));
        expect(setupSource.indexOf('updateCompanionDependencyOptions();')).toBeGreaterThan(setupSource.indexOf('updateCompanionBatchAgentOptions();'));
    });

    test('labels companion agent cards as side execution', () => {
        const labelSource = getFunctionSource('getAgentCardPhaseLabel');

        expect(labelSource).toContain('isCompanionAgent(agent)');
        expect(labelSource).toContain("return 'side';");
        expect(indexSource).toContain('getAgentCardPhaseLabel(agent)');
    });

    test('enables selected post-generation agents on companion outputs', () => {
        const handlerStart = indexSource.indexOf("$('#ica--bulkEnableOnCompanions').on('click'");
        const handlerEnd = indexSource.indexOf("$('#ica--bulkDisable').on('click'", handlerStart);
        const handlerSource = indexSource.slice(handlerStart, handlerEnd);

        expect(settingsSource).toContain('ica--bulkEnableOnCompanions');
        expect(settingsSource).toContain('On Companions');
        expect(handlerSource).toContain('for (const id of selectedAgentIds)');
        expect(handlerSource).toContain('isCompanionAgent(agent)');
        expect(handlerSource).toContain('isToolAgent(agent)');
        expect(handlerSource).toContain("['post', 'both'].includes(agent.phase)");
        expect(handlerSource).toContain('agent.conditions.runOnCompanionOutputs = true;');
        expect(handlerSource).toContain('lockBundledAgentCustomization(agent);');
        expect(handlerSource).toContain('await saveAgent(agent);');
        expect(handlerSource).toContain('exitSelectMode();');
    });

    test('allows manual agent application to multiple selected targets', () => {
        const pickerSource = getFunctionSource('pickManualAgentRunTargets');
        const handlerStart = indexSource.indexOf("card.find('.ica--btn-run-target').on('click'");
        const handlerEnd = indexSource.indexOf("card.find('.ica--btn-preview-prompt').on('click'", handlerStart);
        const handlerSource = indexSource.slice(handlerStart, handlerEnd);

        expect(pickerSource).toContain('type="checkbox" name="ica--run-target"');
        expect(pickerSource).not.toContain('type="radio" name="ica--run-target"');
        expect(pickerSource).toContain("picker.find('input[name=\"ica--run-target\"]:checked').map((_, input) => String(input.value)).get()");
        expect(pickerSource).toContain('return selected.flatMap(value => {');
        expect(handlerSource).toContain('const targets = await pickManualAgentRunTargets(agent);');
        expect(handlerSource).toContain('await Promise.all(targets.map(target => runAgentOnTarget(agent.id, target)));');
    });

    test('allows the manual reply target to expand to an assistant message range', () => {
        const parserSource = getFunctionSource('getManualAgentRunMessageIndices');
        const pickerSource = getFunctionSource('pickManualAgentRunTargets');

        expect(parserSource).toContain("range.split(',')");
        expect(parserSource).toContain('!message.is_user && !message.is_system');
        expect(parserSource).toContain('return [...indexes].sort((a, b) => a - b);');
        expect(pickerSource).toContain('ica--run-target-message-range');
        expect(pickerSource).toContain('Last assistant reply #${lastAssistantIndex}');
        expect(pickerSource).toContain('getManualAgentRunMessageIndices(');
        expect(pickerSource).toContain('return selected.flatMap(value => {');
        expect(extensionStyleSource).toContain('.ica--run-target-range');
    });
});
