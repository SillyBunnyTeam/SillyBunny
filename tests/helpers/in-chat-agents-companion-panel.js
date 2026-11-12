export async function seedCompanionPanel(page) {
    await page.evaluate(async () => {
        const store = await import('/scripts/extensions/in-chat-agents/agent-store.js');
        const app = await import('/script.js');
        const panel = await import('/scripts/extensions/in-chat-agents/companion/companion-panel.js');
        const companion = (id, name, order, displayMode = 'panel') => ({
            ...store.createDefaultAgent(), id, name, execution: 'companion', category: 'companion', enabled: true,
            icon: 'fa-user-astronaut', injection: { order }, companion: { displayMode, format: 'markdown' },
        });
        store.loadAgents([
            companion('qa-scene', 'Scene Tracker', 0),
            companion('qa-expressions', 'Expressions Agent', 10),
            companion('qa-note', 'Continuity Note', 20, 'card'),
        ]);
        store.setGlobalSettings({ enabled: true, separateRecentChats: false });
        const result = (agentName, content, displayMode = 'panel') => ({
            status: 'done', agentName, content, displayMode, format: 'markdown', icon: 'fa-user-astronaut',
        });
        app.chat.splice(0, app.chat.length, {
            is_user: false, is_system: false, name: 'QA Assistant', mes: 'The market quiets as the lanterns come on.',
            extra: { inChatAgentCompanionResults: {
                'qa-scene': result('Scene Tracker', '**Location:** Sumeru City Market\n\nEvening lanterns light the stalls. The party is waiting beside the fountain.'),
                'qa-note': result('Continuity Note', 'The party agreed to meet at the fountain before dusk.', 'card'),
            } },
        });
        document.getElementById('chat').innerHTML = '<div class="mes" mesid="0" is_user="false"><div class="mes_block"><div class="ch_name">QA Assistant</div><div class="mes_text">The market quiets as the lanterns come on.</div></div></div>';
        (await import('/scripts/extensions/in-chat-agents/companion/companion-ui.js')).renderCompanionResultsForMessage(0);
        (await import('/scripts/extensions/in-chat-agents/ui/agent-list.js')).refreshAgentsPanels();
        panel.setCompanionPanelLocked(false);
        panel.updateCompanionPanelHandleVisibility();
        window.$('#themes').val('Libadwaita').trigger('change');
    });
}
