/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from '@jest/globals';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const jquerySource = readFileSync(new URL('../public/lib/jquery-3.5.1.min.js', import.meta.url), 'utf8');

/**
 * The clone prototypes of upstream SillyTavern, each with a selector that extensions and core use on it.
 * They must stay live hidden elements: an extension that runs `$('#message_template .mes_buttons .extraMesButtons')`
 * finds nothing in an inert <template>, because a query does not enter template content.
 */
const PROTOTYPES = [
    ['zoomed_avatar_template', '.zoomed_avatar'],
    ['user_avatar_template', '.avatar-container'],
    ['character_world_template', '.character_world'],
    ['past_chat_template', '.select_chat_block_wrapper'],
    ['tag_view_template', '.tag_view_item'],
    ['entry_edit_template', '.world_entry_edit'],
    ['character_template', '.character_select'],
    ['tag_template', '.tag'],
    ['openai_logit_bias_template', '.openai_logit_bias_form'],
    ['logit_bias_template', '.logit_bias_form'],
    ['message_template', '.mes'],
    ['group_avatars_template', '.collage_1'],
    ['group_list_template', '.group_select'],
    ['bogus_folder_template', '.bogus_folder_select'],
    ['bogus_folder_back_template', '.bogus_folder_select_back'],
    ['inline_avatar_template', '.inline_avatar'],
    ['alternate_greetings_template', '.alternate_grettings'],
    ['alternate_greeting_form_template', '.alternate_greeting'],
    ['message_file_template', '.mes_file_container'],
    ['message_image_template', '.mes_img_container'],
    ['message_video_template', '.mes_video_container'],
    ['message_gallery_controls', '.mes_img_swipes'],
    ['message_audio_template', '.mes_audio_container'],
];

beforeAll(() => {
    (0, eval)(jquerySource);
    const parsed = new DOMParser().parseFromString(indexHtml, 'text/html');
    document.body.innerHTML = parsed.body.innerHTML;
});

describe('the clone prototypes of public/index.html', () => {
    test.each(PROTOTYPES)('%s is a live hidden element that a selector reaches', (id, selector) => {
        const host = document.getElementById(id);
        expect(host).not.toBeNull();
        expect(host.tagName).toBe('DIV');
        expect(host.classList.contains('template_element')).toBe(true);
        expect(document.querySelectorAll(`#${id} ${selector}`)).toHaveLength(1);
        expect($(`#${id} ${selector}`)).toHaveLength(1);
        expect($(`#${id}`).children().length).toBeGreaterThan(0);
        expect($(`#${id}`).find(selector)).toHaveLength(1);
    });

    test('an extension finds the message buttons container of the prototype', () => {
        expect($('#message_template .mes_buttons .extraMesButtons')).toHaveLength(1);
    });

    test('a descendant of a prototype is found by id', () => {
        expect(document.getElementById('BogusFolderBack')).not.toBeNull();
    });

    test('an edit of the live prototype shows in the next clone', () => {
        const prototype = $('#tag_template .tag');
        prototype.attr('data-extension-edit', 'yes');
        expect($('#tag_template .tag').clone().attr('data-extension-edit')).toBe('yes');
        prototype.removeAttr('data-extension-edit');
    });

    test('no prototype is an inert <template> element', () => {
        expect(document.querySelectorAll('template.template_element')).toHaveLength(0);
    });
});
