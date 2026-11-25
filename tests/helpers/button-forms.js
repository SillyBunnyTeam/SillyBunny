import { readFileSync } from 'node:fs';

// DESIGN.md, Buttons, Content: outside the top bar a button shows an icon or a label, not both. Each row below names one
// button of a surface that was changed to that rule, by the file that holds its markup and a selector.
// 'label': the button has visible text and no icon. 'icon': the button has an icon, no text, and a tooltip and accessible
// name that are the same label.
//
// To enforce the rule on more surfaces, add rows here. To enforce it on whole files, call `iconAndLabelButtons()` on the
// parsed markup of each file and keep an allowlist of the kinds that carry both on purpose (menu items, button rows, tabs
// and view switchers, disclosure arrows); a row that names a button is the stricter check and stays.
export const BUTTON_FORMS = [
    { file: 'index.html', form: 'label', selectors: ['#clear_all_cache_button', '#clear_cookies_cache_button', '#movingUIreset', '#chat_tools_cancel', '#chat_cleanup_preview', '#chat_cleanup_run', '#group_add_greeting', '#group_speaker_now', '#group_speaker_hide'] },
    { file: 'index.html', form: 'icon', selectors: ['.open_alternate_greetings', '#sb_character_add_group_greeting'] },
    { file: 'scripts/sillybunny-conversation/settings-panel.js', form: 'label', selectors: ['.sb-schedule-modal-add'] },
    { file: 'scripts/extensions/in-chat-agents/pathfinder/prompts/prompt-editor-ui.js', form: 'label', selectors: ['#pf-prompt-save'] },
    { file: 'scripts/extensions/in-chat-agents/companion/companion-panel.js', form: 'label', selectors: ['[data-action="panel-hide-before"]'] },
    { file: 'scripts/extensions/in-chat-agents/agent-runner.js', form: 'label', selectors: ['button.caution'] },
    { file: 'scripts/BulkEditOverlay.js', form: 'label', selectors: ['#bulk_tag_popup_reset', '#bulk_tag_popup_remove_mutual'] },
    { file: 'scripts/extensions/in-chat-agents/pathfinder-settings.html', form: 'label', selectors: ['#pf--refresh-lorebooks', '#pf--prompt-save', '#pf--prompt-reset', '#pf--summary-create', '#pf--summary-save', '#pf--summary-save-entry', '#pf--run-diagnostics', '#pf--copy-diagnostics', '#pf--refresh-log', '#pf--clear-log'] },
    { file: 'scripts/extensions/expressions/settings.html', form: 'label', selectors: ['#expressions_generate_missing_sprites', '#expressions_upload_sprite_sheet', '#expressions_redo_sprite_cleanup', '#expressions_stop_sprite_generation', '#expression_upload_pack_button', '#expressions_remove_all_sprites', '#expression_override_cleanup_button'] },
    { file: 'scripts/extensions/expressions/settings.html', form: 'icon', selectors: ['#expression_custom_add', '#expression_custom_remove', '#expression_override_button', '#expressions_agent_sprite_prompt_restore', '#expression_llm_prompt_restore'] },
    { file: 'scripts/extensions/expressions/list-item.html', form: 'icon', selectors: ['.expression_list_upload', '.expression_list_regenerate', '.expression_list_generate', '.expression_list_delete'] },
    { file: 'scripts/extensions/regex/editor.html', form: 'label', selectors: ['#regex_test_mode_toggle'] },
    { file: 'scripts/templates/dataMaidDialog.html', form: 'label', selectors: ['.dataMaidStartButton'] },
    { file: 'scripts/extensions/connection-manager/folder-manager.html', form: 'label', selectors: ['#add_new_folder'] },
];

export const ICON = 'i[class*="fa-"], svg, img';
export const readPublic = path => readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');

/**
 * The markup of a file as a document. A script holds its markup in strings, so the elements that act as buttons are cut
 * out of the source (a `button`, or a `div` that carries the `menu_button` class), and a `${...}` placeholder becomes `x`.
 * @param {string} file Path under `public/`.
 * @returns {Document}
 */
export function markupOf(file) {
    const text = readPublic(file);
    const html = file.endsWith('.html')
        ? text
        : [...text.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>|<div\b[^>]*\bmenu_button\b[^>]*>[\s\S]*?<\/div>/g)].map(match => match[0]).join('\n').replace(/\$\{[^}]*\}/g, 'x');
    return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

/**
 * The buttons of a parsed document that carry an icon and visible text, the form that Buttons, Content rules out.
 * @param {ParentNode} root
 * @returns {Element[]}
 */
export function iconAndLabelButtons(root) {
    return [...root.querySelectorAll('button, [role="button"], .menu_button')]
        .filter(button => button.querySelector(ICON) && button.textContent.replace(/\s+/g, ' ').trim() !== '');
}
