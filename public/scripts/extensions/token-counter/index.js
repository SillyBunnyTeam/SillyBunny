import { main_api } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { getFriendlyTokenizerName, getTextTokensAsync, getTokenCountAsync, tokenizers } from '../../tokenizers.js';
import { resetScrollHeight, debounce } from '../../utils.js';
import { debounce_timeout } from '../../constants.js';
import { POPUP_TYPE, callGenericPopup } from '../../popup.js';
import { renderExtensionTemplateAsync } from '../../extensions.js';
import { t } from '../../i18n.js';

async function doTokenCounter() {
    const { tokenizerName, tokenizerId } = getFriendlyTokenizerName(main_api);
    const html = await renderExtensionTemplateAsync('token-counter', 'window', { tokenizerName });

    const dialog = $(html);
    let activeCountSeq = 0;
    const countDebounced = debounce(async () => {
        const seq = ++activeCountSeq;
        const text = String($('#token_counter_textarea').val());
        // SillyBunny: use async token encoding so live typing never blocks the main thread on sync XHR.
        const targetTokenizer = main_api == 'openai' ? tokenizers.OPENAI : tokenizerId;
        const ids = text.length > 0 ? await getTextTokensAsync(targetTokenizer, text) : [];
        if (seq !== activeCountSeq) {
            return;
        }

        if (Array.isArray(ids) && ids.length > 0) {
            $('#token_counter_ids').text(`[${ids.join(', ')}]`);
            $('#token_counter_result').text(ids.length);

            if (Object.hasOwnProperty.call(ids, 'chunks')) {
                drawChunks(Object.getOwnPropertyDescriptor(ids, 'chunks').value, ids);
            }
        } else {
            const count = await getTokenCountAsync(text);
            if (seq !== activeCountSeq) {
                return;
            }
            $('#token_counter_ids').text('—');
            $('#token_counter_result').text(count);
            $('#tokenized_chunks_display').text('—');
        }

        if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && !CSS.supports('field-sizing', 'content')) {
            await resetScrollHeight($('#token_counter_textarea'));
            await resetScrollHeight($('#token_counter_ids'));
        }
    }, debounce_timeout.relaxed);
    dialog.find('#token_counter_textarea').on('input', () => countDebounced());

    // SillyBunny: group the live tokenizer fields in the shared Window without replacing controls.
    const { tokenCounterOptions } = await import('../../sillybunny-editor/adapters/window-tools-dialogs.js');
    callGenericPopup(dialog, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, ...tokenCounterOptions(dialog) });
}

/**
 * Draws the tokenized chunks in the UI
 * @param {string[]} chunks
 * @param {number[]} ids
 * @param {HTMLElement | null} [container]
 */
export function drawChunks(chunks, ids, container = null) {
    const pastelRainbow = [
        //main_text_color,
        //italics_text_color,
        //quote_text_color,
        '#FFB3BA',
        '#FFDFBA',
        '#FFFFBA',
        '#BFFFBF',
        '#BAE1FF',
        '#FFBAF3',
    ];
    const displayEl = container ?? $('#tokenized_chunks_display').get(0);
    if (!displayEl) {
        return;
    }

    // SillyBunny: batch all chunk elements into a single DocumentFragment and replaceChildren once.
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < chunks.length; i++) {
        let chunk = chunks[i].replace(/[▁Ġ]/g, ' '); // This is a leading space in sentencepiece. More info: Lower one eighth block (U+2581)

        // If <0xHEX>, decode it
        if (/^<0x[0-9A-F]+>$/i.test(chunk)) {
            const code = parseInt(chunk.substring(3, chunk.length - 1), 16);
            chunk = String.fromCodePoint(code);
        }

        // If newline - insert a line break
        if (chunk === '\n') {
            fragment.appendChild(document.createElement('br'));
            continue;
        }

        const color = pastelRainbow[i % pastelRainbow.length];
        const chunkEl = document.createElement('code');
        chunkEl.style.backgroundColor = color;
        chunkEl.textContent = chunk;
        chunkEl.setAttribute('title', String(ids[i]));
        fragment.appendChild(chunkEl);
    }

    if (typeof displayEl.replaceChildren === 'function') {
        displayEl.replaceChildren(fragment);
    } else {
        displayEl.textContent = '';
        displayEl.appendChild(fragment);
    }
}

async function doCount() {
    // get all of the messages in the chat
    const context = getContext();
    const messages = context.chat.filter(x => x.mes && !x.is_system).map(x => x.mes);

    //concat all the messages into a single string
    const allMessages = messages.join(' ');

    console.debug('All messages:', allMessages);

    //toastr success with the token count of the chat
    const count = await getTokenCountAsync(allMessages);
    toastr.success(`Token count: ${count}`);
    return count;
}

export function init() {
    const buttonHtml = `
        <div id="token_counter" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-hashtag extensionsMenuExtensionButton" /></div>` + // SillyBunny: the hash sign names a count; a bare digit reads as a placeholder icon.
            t`Token Counter` +
        '</div>';
    $('#token_counter_wand_container').append(buttonHtml);
    $('#token_counter').on('click', doTokenCounter);
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'count',
        callback: async () => String(await doCount()),
        returns: 'number of tokens',
        helpString: 'Counts the number of tokens in the current chat.',
    }));
}
