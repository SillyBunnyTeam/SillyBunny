/** @jest-environment jsdom */
/* eslint-disable playwright/no-standalone-expect, playwright/prefer-web-first-assertions -- Jest/jsdom DOM assertions. */
import { afterEach, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('../../public/scripts/i18n.js', () => ({ t: parts => parts.join(''), translate: value => value }));
const adapters = await import('../../public/scripts/sillybunny-editor/adapters/side-panels.js');
const { releaseRowIds } = await import('../../public/scripts/sillybunny-editor/rows.js');

function mount(html) {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
}

afterEach(() => {
    releaseRowIds(document.body);
    document.body.replaceChildren();
});

test('Author\'s Note, CFG, and token adapters adopt source controls without changing persistence events', () => {
    const host = mount(`
        <section id="floatingPrompt">
            <div class="panelControlBar"><div id="ANClose"></div></div>
            <div name="floatingPromptHolder" class="scrollY">
                <div class="inline-drawer">
                    <div id="ANBlockToggle" class="inline-drawer-toggle"><b data-i18n="Author's Note">Author's Note</b></div>
                    <div class="inline-drawer-content"><small>Unique to this chat</small>
                        <textarea id="extension_floating_prompt" rows="8"></textarea>
                        <span class="extension_token_counter" id="extension_floating_prompt_token_counter">0</span>
                        <label class="checkbox_label" for="extension_floating_allow_wi_scan"><input id="extension_floating_allow_wi_scan" type="checkbox"><span data-i18n="Include in World Info Scanning">Include in World Info Scanning</span></label>
                        <div class="floating_prompt_radio_group">
                            <label><input type="radio" id="extension_floating_position_before" name="extension_floating_position" value="2"><span>Before</span></label>
                            <label><input type="radio" id="extension_floating_position_after" name="extension_floating_position" value="0"><span>After</span></label>
                            <label><input type="radio" id="extension_floating_position_depth" name="extension_floating_position" value="1" checked><span>In-chat @ Depth</span></label>
                        </div>
                        <input id="extension_floating_depth" type="number" min="0" max="9999">
                        <select id="extension_floating_role"><option value="0">System</option><option value="1">User</option><option value="2">Assistant</option></select>
                        <div><label><span data-i18n="Insertion Frequency">Insertion Frequency</span><small data-i18n="(0 = Disable, 1 = Always)">(0 = Disable, 1 = Always)</small></label><input id="extension_floating_interval" type="number" min="0" max="9999"></div>
                        <span><span data-i18n="User inputs until next insertion:">User inputs until next insertion:</span> <span id="extension_floating_counter">(disabled)</span></span>
                    </div>
                </div>
                <div class="inline-drawer">
                    <div id="charaANBlockToggle" class="inline-drawer-toggle"><b data-i18n="Character Author's Note (Private)">Character Author's Note (Private)</b><small data-i18n="Won't be shared with the character card on export.">Private</small></div>
                    <div class="inline-drawer-content"><small data-i18n="Will be saved with this chat and automatically added as the author's note.">Saved with this chat</small>
                        <textarea id="extension_floating_chara" rows="8"></textarea><span id="extension_floating_chara_token_counter">0</span>
                        <label><input id="extension_use_floating_chara" type="checkbox"><span data-i18n="Use character author's note">Use character author's note</span></label>
                        <div class="floating_prompt_radio_group">
                            <label><input type="radio" name="extension_floating_char_position" value="0" checked><span data-i18n="Replace Author's Note">Replace Author's Note</span></label>
                            <label><input type="radio" name="extension_floating_char_position" value="1"><span data-i18n="Top of Author's Note">Top of Author's Note</span></label>
                            <label><input type="radio" name="extension_floating_char_position" value="2"><span data-i18n="Bottom of Author's Note">Bottom of Author's Note</span></label>
                        </div>
                    </div>
                </div>
                <div class="inline-drawer">
                    <div id="defaultANBlockToggle" class="inline-drawer-toggle"><b data-i18n="Default Author's Note">Default Author's Note</b></div>
                    <div class="inline-drawer-content"><small data-i18n="Will be automatically added as the Author's Note for all new chats.">Default for new chats</small>
                        <textarea id="extension_floating_default" rows="8"></textarea><span id="extension_floating_default_token_counter">0</span>
                        <div class="floating_prompt_radio_group">
                            <label><input type="radio" id="extension_default_position_before" name="extension_default_position" value="2"><span>Before</span></label>
                            <label><input type="radio" id="extension_default_position_after" name="extension_default_position" value="0"><span>After</span></label>
                            <label><input type="radio" id="extension_default_position_depth" name="extension_default_position" value="1" checked><span>In-chat @ Depth</span></label>
                        </div>
                        <input id="extension_default_depth" type="number" min="0" max="9999">
                        <select id="extension_default_role"><option value="0">System</option><option value="1">User</option><option value="2">Assistant</option></select>
                        <div><label><span data-i18n="Insertion Frequency">Insertion Frequency</span><small data-i18n="(0 = Disable, 1 = Always)">(0 = Disable, 1 = Always)</small></label><input id="extension_default_interval" type="number" min="0" max="9999"></div>
                    </div>
                </div>
            </div>
        </section>
        <section id="cfgConfig">
            <div class="panelControlBar"><div id="CFGClose"></div></div>
            <div name="cfgConfigHolder" class="scrollY">
                <div id="chat_cfg_container"><div class="inline-drawer"><div id="CFGBlockToggle" class="inline-drawer-toggle"><b data-i18n="Chat CFG">Chat CFG</b></div><div class="inline-drawer-content"><small><b>Unique to this chat.</b></small>
                    <label for="chat_cfg_guidance_scale"><span data-i18n="Scale">Scale</span><small data-i18n="1 = disabled">1 = disabled</small></label><div><input id="chat_cfg_guidance_scale" type="range" min="0.10" max="4.00" step="0.05" value="1"><input id="chat_cfg_guidance_scale_counter" type="number" min="0.10" max="4.00" step="0.05" data-for="chat_cfg_guidance_scale" value="1"></div>
                    <label for="chat_cfg_negative_prompt"><span data-i18n="Negative Prompt">Negative Prompt</span></label><textarea id="chat_cfg_negative_prompt" rows="2"></textarea>
                    <label for="chat_cfg_positive_prompt"><span data-i18n="Positive Prompt">Positive Prompt</span></label><textarea id="chat_cfg_positive_prompt" rows="2"></textarea>
                    <div id="groupchat_cfg_use_chara_container"><label><input id="groupchat_cfg_use_chara" type="checkbox"><span data-i18n="Use character CFG scales">Use character CFG scales</span></label></div>
                </div></div></div>
                <div id="chara_cfg_container" style="display:none"><div class="inline-drawer"><div id="charaCfgBlockToggle" class="inline-drawer-toggle"><b data-i18n="Character CFG">Character CFG</b></div><div class="inline-drawer-content"><small>Character default</small>
                    <label for="chara_cfg_guidance_scale"><span data-i18n="Scale">Scale</span><small data-i18n="1 = disabled">1 = disabled</small></label><div><input id="chara_cfg_guidance_scale" type="range" min="0.10" max="4.00" step="0.05" value="1"><input id="chara_cfg_guidance_scale_counter" type="number" min="0.10" max="4.00" step="0.05" data-for="chara_cfg_guidance_scale" value="1"></div>
                    <label for="chara_cfg_negative_prompt"><span data-i18n="Negative Prompt">Negative Prompt</span></label><textarea id="chara_cfg_negative_prompt" rows="2"></textarea>
                    <label for="chara_cfg_positive_prompt"><span data-i18n="Positive Prompt">Positive Prompt</span></label><textarea id="chara_cfg_positive_prompt" rows="2"></textarea>
                </div></div></div>
                <div id="global_cfg_container"><div class="inline-drawer"><div id="globalCfgBlockToggle" class="inline-drawer-toggle"><b data-i18n="Global CFG">Global CFG</b></div><div class="inline-drawer-content"><small>Global default</small>
                    <label for="global_cfg_guidance_scale"><span data-i18n="Scale">Scale</span><small data-i18n="1 = disabled">1 = disabled</small></label><div><input id="global_cfg_guidance_scale" type="range" min="0.10" max="4.00" step="0.05" value="1"><input id="global_cfg_guidance_scale_counter" type="number" min="0.10" max="4.00" step="0.05" data-for="global_cfg_guidance_scale" value="1"></div>
                    <label for="global_cfg_negative_prompt"><span data-i18n="Negative Prompt">Negative Prompt</span></label><textarea id="global_cfg_negative_prompt" rows="2"></textarea>
                    <label for="global_cfg_positive_prompt"><span data-i18n="Positive Prompt">Positive Prompt</span></label><textarea id="global_cfg_positive_prompt" rows="2"></textarea>
                </div></div></div>
                <div id="cfg_prompt_combine_container"><div class="inline-drawer"><div id="cfgPromptCombineBlockToggle" class="inline-drawer-toggle"><b data-i18n="CFG Prompt Cascading">CFG Prompt Cascading</b></div><div class="inline-drawer-content"><small data-i18n="Combine positive/negative prompts from other boxes.">Combine positive/negative prompts</small>
                    <label data-i18n="Always Include">Always Include</label>
                    <label><input type="checkbox" name="cfg_prompt_combine" value="0"><span data-i18n="Chat Negatives">Chat Negatives</span></label>
                    <label><input type="checkbox" name="cfg_prompt_combine" value="1"><span data-i18n="Character Negatives">Character Negatives</span></label>
                    <label><input type="checkbox" name="cfg_prompt_combine" value="2"><span data-i18n="Global Negatives">Global Negatives</span></label>
                    <label><span data-i18n="Custom Separator:">Custom Separator:</span><input id="cfg_prompt_separator" type="text"></label>
                    <label><span data-i18n="Insertion Depth:">Insertion Depth:</span><input id="cfg_prompt_insertion_depth" type="number" min="0" max="99"></label>
                </div></div></div>
            </div>
        </section>
        <section id="logprobsViewer"><div class="logprobs_panel_header"><b>Token Probabilities</b></div><div class="logprobs_panel_content inline-drawer-content"><div id="logprobs_generation_output">output</div><div id="logprobs_selected_top_logprobs" class="logprobs_candidate_list">tokens</div></div></section>
    `);

    const authorPrompt = host.querySelector('#extension_floating_prompt');
    const mainPositionBefore = host.querySelector('#extension_floating_position_before');
    const mainPositionDepth = host.querySelector('#extension_floating_position_depth');
    const frequency = host.querySelector('#extension_floating_interval');
    const frequencyInput = jest.fn();
    const savedPrompt = jest.fn();
    const savedPosition = jest.fn();
    frequency.addEventListener('input', frequencyInput);
    authorPrompt.addEventListener('input', savedPrompt);
    mainPositionBefore.addEventListener('change', savedPosition);

    const authorController = adapters.registerAuthorsNotePanel(host.querySelector('#floatingPrompt'));
    const cfgController = adapters.registerCfgPanel(host.querySelector('#cfgConfig'));
    const tokenController = adapters.registerTokenProbabilitiesPanel(host.querySelector('#logprobsViewer'));

    expect(host.querySelectorAll('#floatingPrompt .ds-pref-group')).toHaveLength(3);
    expect(host.querySelectorAll('#floatingPrompt .ds-row--stacked textarea')).toHaveLength(3);
    expect(host.querySelector('#ANBlockToggle')).not.toBeNull();
    expect(host.querySelector('#extension_floating_prompt')).toBe(authorPrompt);
    expect([mainPositionBefore.id, mainPositionBefore.name, mainPositionBefore.value]).toEqual([
        'extension_floating_position_before', 'extension_floating_position', '2',
    ]);
    const mainPositionGroup = host.querySelector('.ds-row[data-sb-editor-field="authors-note-main-position"] .ds-toggle-row__group');
    expect(mainPositionGroup.getAttribute('role')).toBe('radiogroup');
    expect([...mainPositionGroup.querySelectorAll('input[type="radio"]')].map(input => input.value)).toEqual(['2', '0', '1']);
    expect(host.querySelector('.ds-row[data-sb-editor-field="authors-note-main-depth"]').hidden).toBe(false);
    expect(host.querySelector('.ds-row[data-sb-editor-field="authors-note-main-role"]').hidden).toBe(false);
    expect(host.querySelector('.ds-row[data-sb-editor-field="authors-note-default-depth"]').hidden).toBe(false);

    mainPositionBefore.click();
    expect(mainPositionBefore.checked).toBe(true);
    expect(mainPositionDepth.checked).toBe(false);
    expect(savedPosition).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.ds-row[data-sb-editor-field="authors-note-main-depth"]').hidden).toBe(true);
    expect(host.querySelector('.ds-row[data-sb-editor-field="authors-note-main-role"]').hidden).toBe(true);
    mainPositionDepth.click();
    expect(host.querySelector('.ds-row[data-sb-editor-field="authors-note-main-depth"]').hidden).toBe(false);
    expect(host.querySelector('.ds-row[data-sb-editor-field="authors-note-main-role"]').hidden).toBe(false);

    const characterPositionGroup = host.querySelector('.ds-row[data-sb-editor-field="authors-note-character-position"] .ds-toggle-row__group');
    expect(characterPositionGroup.getAttribute('role')).toBe('radiogroup');
    expect(characterPositionGroup.classList.contains('ds-toggle-row__group--fill')).toBe(true);
    const characterHeader = host.querySelector('.sb-editor-section[data-sb-editor-field="authors-note-character"] .ds-pref-group-header');
    expect([...characterHeader.querySelectorAll('.ds-pref-group-subtitle')].map(subtitle => subtitle.dataset.i18n)).toEqual([
        'Will be saved with this chat and automatically added as the author\'s note.',
        'Won\'t be shared with the character card on export.',
    ]);

    authorPrompt.value = 'unchanged chat note';
    authorPrompt.dispatchEvent(new Event('input', { bubbles: true }));
    frequency.value = '-4';
    frequency.dispatchEvent(new Event('input', { bubbles: true }));
    expect(savedPrompt).toHaveBeenCalledTimes(1);
    expect(frequencyInput).toHaveBeenCalledTimes(1);
    expect(frequency.value).toBe('-4');
    expect([frequency.min, frequency.max]).toEqual(['0', '9999']);
    expect(host.querySelectorAll('#floatingPrompt input[type="radio"][name="extension_floating_position"]')).toHaveLength(3);

    expect(host.querySelectorAll('#cfgConfig .ds-pref-group')).toHaveLength(4);
    expect(host.querySelectorAll('#cfgConfig .ds-row-slider')).toHaveLength(3);
    expect(host.querySelectorAll('#cfgConfig .ds-row--stacked textarea')).toHaveLength(6);
    expect(host.querySelectorAll('#cfgConfig .ds-row-check input[name="cfg_prompt_combine"][type="checkbox"][role="switch"]')).toHaveLength(0);
    expect(host.querySelectorAll('#cfgConfig .ds-row-check input[name="cfg_prompt_combine"][type="checkbox"]')).toHaveLength(3);
    expect(host.querySelector('#chat_cfg_guidance_scale')).toBe(host.querySelector('.ds-row-slider input[type="range"]'));
    expect(host.querySelector('#cfg_prompt_insertion_depth').closest('.ds-row')).not.toBeNull();
    expect(host.querySelector('#cfg_prompt_insertion_depth').min).toBe('0');
    expect(host.querySelector('#cfg_prompt_insertion_depth').max).toBe('99');

    const tokenContent = host.querySelector('#logprobsViewer .logprobs_panel_content');
    expect(tokenContent.closest('.ds-pref-group')).not.toBeNull();
    expect(host.querySelector('#logprobs_generation_output')).toBe(tokenContent.querySelector('#logprobs_generation_output'));
    expect(authorController.isOpen).toBe(false);
    expect(cfgController.isOpen).toBe(false);
    expect(tokenController.isOpen).toBe(false);

    authorController.unregister();
    cfgController.unregister();
    tokenController.unregister();
});
