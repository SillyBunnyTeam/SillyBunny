import { branchChat } from './bookmarks.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from './constants.js';
import { t } from './i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
// SillyBunny: committed swipe deletion uses the shared alert contract.
import { openAlert } from './sillybunny-editor/dialog.js';
import { power_user } from './power-user.js';
// SillyBunny: the row's actions are one menu, so a row holds a single trailing control.
import { openActionMenu } from './sillybunny-action-menu.js';
import { isMobile } from './RossAscends-mods.js';
// SillyBunny: loads the entity list sheet for the entity rows.
import { loadStylesheetAsync } from './dynamic-styles.js';
import { getTokenCountAsync } from './tokenizers.js';
import { addLongPressEvent, clamp, copyText, timestampToMoment } from './utils.js';
import { cloneTemplate } from './dom-template.js'; // SillyBunny: clone inert <template> elements.
import { bindListFocus } from './sillybunny-editor/list-focus.js'; // SillyBunny: the swipe rows are one Tab stop with arrow keys
import { chat, deleteSwipe, ensureSwipes, isMessageSwipeable, isSwipingAllowed, swipe, syncMesToSwipe } from '/script.js';

// SillyBunny: the rows are shared entity rows, which a deferred sheet styles.
const ENTITY_LIST_STYLESHEET = { href: 'css/sillybunny-entity-list.css?v=20261118zza', id: 'deferred-entity-list-css' };

/**
 * Returns whether a swipe picker can be opened for the message.
 * Unlike message swiping, this supports historical AI messages for inspection and branching.
 * @param {number} messageId
 * @returns {boolean}
 */
export function canOpenSwipePickerForMessage(messageId) {
    const message = chat[messageId];

    if (!message) {
        return false;
    }

    if (ensureSwipes(message)) {
        syncMesToSwipe(messageId);
    }

    return Boolean(
        message?.swipes?.length > 1 &&
        !message?.is_user &&
        !(message?.extra?.isSmallSys) &&
        !(message?.extra?.swipeable === false),
    );
}

/**
 * Returns whether the picker can actively jump to a different swipe.
 * Historical AI messages can open the picker, but only the currently swipeable message may jump.
 * @param {number} messageId
 * @returns {boolean}
 */
export function canJumpToSwipeForMessage(messageId) {
    const message = chat[messageId];
    return canOpenSwipePickerForMessage(messageId) && isSwipingAllowed() && isMessageSwipeable(messageId, message);
}

/**
 * Opens a popup for viewing or jumping to a specific swipe on a message.
 * @param {number} messageId
 * @returns {Promise<void>}
 */
async function openSwipePicker(messageId) {
    const message = chat[messageId];

    if (!canOpenSwipePickerForMessage(messageId)) {
        toastr.info(t`This message has no alternate swipes yet.`, t`Jump to Swipe`);
        return;
    }

    const canJumpToSwipe = canJumpToSwipeForMessage(messageId);
    let selectedSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);
    const swipeIdInputId = `swipe_picker_id_${messageId}`;
    const wrapper = document.createElement('div');
    wrapper.classList.add('flex-container', 'flexFlowColumn', 'flexNoGap', 'wide100p', 'flex1', 'overflowHidden');

    const listContainer = document.createElement('div');
    listContainer.classList.add('swipe_picker_div', 'flex1', 'marginTop10');
    wrapper.appendChild(listContainer);
    // SillyBunny: the swipe rows are one Tab stop with arrow keys, as the shared lists.
    bindListFocus(listContainer, { rowSelector: '.swipe_picker_block' });

    /** @type {Popup} */
    let popup;
    /** @type {HTMLInputElement} */
    let swipeIdInput;
    /** @type {number|null} */
    let branchActionSwipeId = null;

    function syncSwipeIdInput() {
        if (swipeIdInput) {
            swipeIdInput.value = String(selectedSwipeId + 1);
        }
    }

    function setSelectedSwipe(nextSwipeId) {
        selectedSwipeId = clamp(Number(nextSwipeId), 0, message.swipes.length - 1);
        listContainer.querySelectorAll('.swipe_picker_block').forEach((element) => {
            const isSelected = Number(element.getAttribute('data-swipe-id')) === selectedSwipeId;
            // SillyBunny: the shared entity row draws its selected fill from `is-selected`, and the select button reports the current row.
            element.classList.toggle('is-selected', isSelected);
            element.querySelector('.swipe_picker_select')?.toggleAttribute('aria-current', isSelected);
            if (isSelected) {
                element.setAttribute('highlight', 'true');
            } else {
                element.removeAttribute('highlight');
            }
        });
        syncSwipeIdInput();
    }

    function scrollToSelectedSwipe() {
        const swipeBlock = listContainer.querySelector(`.swipe_picker_block[data-swipe-id="${selectedSwipeId}"]`);
        if (swipeBlock instanceof HTMLElement) {
            const scrollParent = swipeBlock.closest('.swipe_picker_div');
            if (scrollParent instanceof HTMLElement) {
                const blockRect = swipeBlock.getBoundingClientRect();
                const parentRect = scrollParent.getBoundingClientRect();
                // SillyBunny: the opening animation scales both rectangles, and `scrollTop` is in layout pixels.
                const scale = parentRect.height / scrollParent.offsetHeight || 1;
                if (blockRect.top < parentRect.top) {
                    scrollParent.scrollTop -= (parentRect.top - blockRect.top) / scale + 5;
                } else if (blockRect.bottom > parentRect.bottom) {
                    scrollParent.scrollTop += (blockRect.bottom - parentRect.bottom) / scale + 5;
                }
            }
        }
    }

    function canDeleteSwipeFromPicker(swipeId) {
        if ((message?.swipes?.length ?? 0) <= 1) {
            return false;
        }

        const currentSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);
        return canJumpToSwipe || swipeId !== currentSwipeId;
    }

    async function renderSwipeList() {
        const swipeBlocks = await Promise.all(message.swipes.map(async (swipe, index) => {
            const swipeText = String(swipe ?? '');
            // SillyBunny: clone from inert <template id="past_chat_template">.
            const template = cloneTemplate('past_chat_template', '.select_chat_block_wrapper');
            const block = template.find('.select_chat_block');
            // SillyBunny: `.swipe_picker_block` is a keyboard interactable that would take its own Tab stop. The select button covers
            // the whole row, so the row is not focusable and the button is its stop (`not_focusable` keeps keyboard.js from adding a tabindex).
            block.removeClass('select_chat_block').addClass('swipe_picker_block not_focusable');
            const branchButton = template.find('.exportRawChatButton');
            const deleteButton = template.find('.PastChat_cross');
            const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info[index] : null;
            const sendDate = swipeInfo?.send_date ? timestampToMoment(swipeInfo.send_date).format('lll') : '';
            const previewText = swipeText.replace(/\s+/g, ' ').trim();
            const tokenCount = swipeInfo?.extra?.token_count ?? await getTokenCountAsync(swipeText, 0);
            const canDeleteSwipe = canDeleteSwipeFromPicker(index);
            const swipeDetails = [];

            if (previewText) {
                swipeDetails.push(`${previewText.length} ${t`chars`}`);
            }

            if (tokenCount) {
                swipeDetails.push(`${tokenCount}t`);
            }

            block.attr({
                file_name: `swipe-${index + 1}`,
                'data-swipe-id': index,
            });

            template.find('.renameChatButton, .exportChatButton').remove();
            branchButton
                .removeAttr('data-format')
                .attr({
                    title: t`Create Branch`,
                    'data-i18n': '[title]Create Branch',
                    // SillyBunny: cloned div controls need a keyboard and assistive-technology role.
                    role: 'button',
                    tabindex: '0',
                    'aria-label': t`Create Branch`,
                })
                .removeClass('exportRawChatButton fa-solid fa-file-export')
                .addClass('swipe_picker_branch mes_button fa-fw fa-regular fa-code-branch')
                .on('click', async (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedSwipe(index);
                    branchActionSwipeId = index;
                    await popup.completeCancelled();
                })
                .on('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.currentTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                });
            // SillyBunny: cloned div controls need a keyboard and assistive-technology role.
            deleteButton
                .removeAttr('file_name')
                .attr({
                    'aria-disabled': String(!canDeleteSwipe),
                    role: 'button',
                    tabindex: canDeleteSwipe ? '0' : '-1',
                    'aria-label': t`Delete Swipe`,
                })
                .removeClass('fa-skull')
                .addClass('swipe_picker_delete fa-fw fa-trash-can')
                .toggleClass('hoverglow', canDeleteSwipe)
                .toggleClass('disabled', !canDeleteSwipe)
                .each(function () {
                    if (canDeleteSwipe) {
                        $(this)
                            .attr({
                                title: t`Delete Swipe`,
                                'data-i18n': '[title]Delete Swipe',
                            });
                    } else {
                        $(this)
                            .removeAttr('title')
                            .removeAttr('data-i18n');
                    }
                })
                .off('click')
                .on('click', async (event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (!canDeleteSwipe) {
                        return;
                    }

                    const nextSelectedSwipeId = index < selectedSwipeId
                        ? selectedSwipeId - 1
                        : index > selectedSwipeId
                            ? selectedSwipeId
                            : Math.min(selectedSwipeId, message.swipes.length - 2);

                    // SillyBunny: destructive swipe confirmations use the shared Alert while preserving the existing preference gate.
                    if (power_user.confirm_message_delete) {
                        const result = await openAlert({
                            heading: t`Delete Swipe`,
                            body: t`Are you sure you want to delete swipe #${index + 1}?`,
                            responses: [
                                { id: 'cancel', label: t`Cancel` },
                                { id: 'delete', label: t`Delete Swipe`, appearance: 'destructive' },
                            ],
                        });

                        if (result !== 'delete') {
                            return;
                        }
                    }

                    const newSwipeId = await deleteSwipe(index, messageId);
                    if (!Number.isInteger(newSwipeId)) {
                        return;
                    }

                    selectedSwipeId = clamp(nextSelectedSwipeId, 0, message.swipes.length - 1);

                    if (swipeIdInput instanceof HTMLInputElement) {
                        swipeIdInput.max = String(message.swipes.length);
                    }

                    await renderSwipeList();
                })
                .on('keydown', event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.currentTarget.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                });

            // Add expand/collapse toggle
            const expandCheckboxId = `swipe_picker_expand_${messageId}_${index}`;
            const expandCheckbox = document.createElement('input');
            expandCheckbox.type = 'checkbox';
            expandCheckbox.id = expandCheckboxId;
            expandCheckbox.classList.add('swipe_picker_expand_toggle');
            expandCheckbox.setAttribute('aria-label', t`Expand/Collapse`);
            block[0].prepend(expandCheckbox);

            const expandLabel = document.createElement('label');
            expandLabel.htmlFor = expandCheckboxId;
            expandLabel.classList.add('swipe_picker_expand_label', 'fa-solid', 'fa-fw', 'fa-chevron-down');
            expandLabel.title = t`Expand/Collapse`;
            expandLabel.setAttribute('data-i18n', '[title]Expand/Collapse');
            expandLabel.addEventListener('click', (event) => event.stopPropagation());

            // Add copy button
            const copyButton = document.createElement('div');
            copyButton.classList.add('swipe_picker_copy', 'fa-solid', 'fa-fw', 'fa-copy');
            copyButton.title = t`Copy`;
            copyButton.setAttribute('data-i18n', '[title]Copy');
            // SillyBunny: cloned div controls need a keyboard and assistive-technology role.
            copyButton.setAttribute('role', 'button');
            copyButton.setAttribute('tabindex', '0');
            copyButton.setAttribute('aria-label', t`Copy`);
            copyButton.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                await copyText(swipeText);
                toastr.info(t`Copied!`, '', { timeOut: 2000 });
            });
            copyButton.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                copyButton.click();
            });

            // Insert new buttons before the branch button
            branchButton.before(expandLabel, copyButton);

            // SillyBunny: a boxed-list row holds at most two trailing controls, so the four actions fold into one menu. The
            // original controls stay in the row, hidden, and the menu clicks them, so their handlers (and any extension's) still run.
            const forwarded = [expandLabel, copyButton, branchButton[0], deleteButton[0]];
            forwarded.forEach(node => {
                node.setAttribute('data-sb-forwarded', '');
                node.setAttribute('tabindex', '-1');
                node.setAttribute('aria-hidden', 'true');
            });
            // SillyBunny: the row's activating area is a button of its own, a sibling of the menu button. A button inside a
            // role=button row is a nested interactive control, which assistive technology cannot announce or reach reliably.
            // The button comes first in the row so that Tab reaches it before the menu button, covers the whole row, and has the menu button above it.
            const selectButton = document.createElement('button');
            selectButton.type = 'button';
            selectButton.className = 'swipe_picker_select';
            selectButton.setAttribute('aria-label', `#${index + 1}`);
            // The name stays the short `#N`; the swipe's text is the description.
            const previewId = `swipe_picker_preview_${messageId}_${index}`;
            block.find('.select_chat_block_mes').attr('id', previewId);
            selectButton.setAttribute('aria-describedby', previewId);
            block[0].prepend(selectButton);
            const menuButton = document.createElement('button');
            menuButton.type = 'button';
            menuButton.className = 'swipe_picker_menu';
            menuButton.title = t`Menu`;
            menuButton.setAttribute('aria-label', t`Menu`);
            menuButton.setAttribute('aria-haspopup', 'menu');
            menuButton.innerHTML = '<i class="fa-solid fa-ellipsis-vertical" aria-hidden="true"></i>';
            const openSwipeMenu = (keyboard) => {
                const sections = [{
                    items: [
                        { label: t`Expand/Collapse`, icon: 'fa-solid fa-chevron-down', onSelect: () => expandLabel.click() },
                        { label: t`Copy`, icon: 'fa-solid fa-copy', onSelect: () => copyButton.click() },
                        { label: t`Create Branch`, icon: 'fa-regular fa-code-branch', onSelect: () => branchButton[0].click() },
                    ],
                }];
                // A swipe that cannot be deleted leaves the menu, as an item that does not apply does.
                if (canDeleteSwipe) {
                    sections.push({ items: [{ label: t`Delete Swipe`, icon: 'fa-solid fa-trash-can', danger: true, onSelect: () => deleteButton[0].click() }] });
                }
                openActionMenu({ trigger: menuButton, title: `#${index + 1}`, sections, keyboard, bounds: popup.dlg });
            };
            menuButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                openSwipeMenu(event.detail === 0);
            });
            // The Menu key and Shift+F10 open the same menu from the row's select button, as a secondary click does elsewhere.
            selectButton.addEventListener('keydown', (event) => {
                if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
                event.preventDefault();
                event.stopPropagation();
                openSwipeMenu(true);
            });
            branchButton[0].parentElement.append(menuButton);

            const swipeTitle = block.find('.select_chat_block_filename').first()[0];
            swipeTitle.textContent = `#${index + 1}`;
            if (index === Number(message.swipe_id ?? 0)) {
                const currentMarker = document.createElement('span');
                currentMarker.className = 'swipe_picker_current';
                currentMarker.textContent = t`[Current]`;
                swipeTitle.append(' ', currentMarker);
            }
            template.find('.chat_messages_date').text(sendDate);
            // SillyBunny: the details are plain text, because the entity row's subtitle separates them.
            template.find('.chat_file_size').text(swipeDetails[0] ?? '');
            template.find('.chat_messages_num').text(swipeDetails.slice(1).join(', '));
            template.find('.select_chat_block_mes').text(previewText ? swipeText : t`(empty swipe)`);

            // SillyBunny: the row is the shared entity row on the cloned chat-file node: a title, the details as its subtitle, the
            // swipe's text as a preview, and the one menu button as its suffix. Every upstream control stays in the row, hidden.
            const rowTitle = block.find('.select_chat_block_filename').first()[0];
            const rowDetails = block.find('.select_chat_info')[0];
            const rowPreview = block.find('.select_chat_block_mes')[0];
            block[0].querySelectorAll('.select_chat_block_filename_item').forEach(node => node.classList.remove('select_chat_block_filename_item'));
            block.addClass('ds-entity-row ds-entity-row--activatable');
            const text = document.createElement('span');
            text.className = 'ds-entity-row__text';
            rowTitle.classList.add('ds-entity-row__title');
            rowDetails.classList.add('ds-entity-row__subtitle');
            rowPreview.classList.add('ds-entity-row__preview');
            text.append(rowTitle, rowDetails, rowPreview);
            const suffix = document.createElement('span');
            suffix.className = 'ds-entity-row__suffix';
            menuButton.classList.add('ds-entity-row__button');
            suffix.append(menuButton);
            const store = document.createElement('span');
            store.hidden = true;
            store.append(expandCheckbox, ...forwarded);
            block[0].replaceChildren(selectButton, text, suffix, store);

            // SillyBunny: the select button's click covers pointer and keyboard activation, so both use one selection and commit path.
            selectButton.addEventListener('click', async () => {
                setSelectedSwipe(index);
                if (canJumpToSwipe) await popup.completeAffirmative();
            });
            block.on('dblclick', async () => {
                if (!canJumpToSwipe) {
                    return;
                }

                setSelectedSwipe(index);
                await popup.completeAffirmative();
            });

            return template[0];
        }));

        listContainer.replaceChildren(...swipeBlocks);
        setSelectedSwipe(selectedSwipeId);

        if (swipeBlocks.length === 0) {
            const empty = document.createElement('div');
            empty.classList.add('textAlignCenter', 'opacity50p', 'padding10');
            empty.textContent = t`No swipes available.`;
            listContainer.replaceChildren(empty);
        }
    }

    // SillyBunny: the shared Window owns the title, Close control, and overlay presentation.
    popup = new Popup(wrapper, POPUP_TYPE.CONFIRM, '', {
        okButton: false,
        cancelButton: false,
        customButtons: canJumpToSwipe ? [{ text: t`Go`, result: POPUP_RESULT.AFFIRMATIVE, appendAtEnd: true, classes: ['menu_button_primary'] }] : null,
        tier: 'window',
        title: t`Swipe Selection`,
        customInputs: [{
            id: swipeIdInputId,
            label: t`Swipe ID`,
            type: 'text',
            defaultState: String(selectedSwipeId + 1),
            tooltip: `1-${message.swipes.length}`,
        }],
        large: true,
        wider: true,
        allowVerticalScrolling: true,
        onOpening: function () {
            const footer = popup.buttonControls.querySelector('.sb-dialog__bottom-bar');
            if (footer instanceof HTMLElement) {
                footer.classList.add('swipe_picker_footer');
                if (swipeIdLabel instanceof HTMLLabelElement) footer.prepend(swipeIdLabel);
                // SillyBunny: the list gives up the height of the footer, and `scrollToSelectedSwipe` depends on the list height.
                popup.sbFrame.contentChanged();
            }
            scrollToSelectedSwipe();
            if (swipeIdInput instanceof HTMLInputElement) {
                swipeIdInput.focus({ preventScroll: true });
                swipeIdInput.select();
            }
        },
        onClosing: function (popup) {
            if (popup.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            const swipeIdInput = popup.dlg.querySelector(`#${swipeIdInputId}`);
            const targetSwipeNumber = Number.parseInt(String(swipeIdInput instanceof HTMLInputElement ? swipeIdInput.value : '').trim(), 10);

            if (!Number.isInteger(targetSwipeNumber) || targetSwipeNumber < 1 || targetSwipeNumber > message.swipes.length) {
                toastr.warning(t`Enter a swipe ID between 1 and ${message.swipes.length}.`, t`Jump to Swipe`);
                if (swipeIdInput instanceof HTMLInputElement) {
                    swipeIdInput.focus({ preventScroll: true });
                    swipeIdInput.select();
                }
                return false;
            }

            setSelectedSwipe(targetSwipeNumber - 1);
            return true;
        },
    });

    // SillyBunny: keep the existing picker class while the shared Window owns presentation.
    popup.dlg.classList.add('swipe_picker_popup');

    swipeIdInput = popup.dlg.querySelector(`#${swipeIdInputId}`);
    const swipeIdLabel = popup.dlg.querySelector(`label[for="${swipeIdInputId}"]`);

    if (swipeIdLabel instanceof HTMLLabelElement) {
        swipeIdLabel.classList.add('flex-container', 'alignItemsCenter', 'justifyCenter', 'gap10px', 'margin0', 'swipe_picker_id_row');
        popup.inputControls.style.display = 'none';
    }

    if (swipeIdInput instanceof HTMLInputElement) {
        swipeIdInput.type = 'number';
        swipeIdInput.min = '1';
        swipeIdInput.max = String(message.swipes.length);
        swipeIdInput.step = '1';
        swipeIdInput.inputMode = 'numeric';
        swipeIdInput.classList.add('flex1', 'width100px', 'textAlignCenter');
        swipeIdInput.setAttribute('autofocus', '');
        syncSwipeIdInput();

        swipeIdInput.addEventListener('input', function () {
            const nextSwipeId = Number.parseInt(this.value, 10);
            if (!Number.isInteger(nextSwipeId) || nextSwipeId < 1 || nextSwipeId > message.swipes.length) {
                return;
            }

            setSelectedSwipe(nextSwipeId - 1);
            scrollToSelectedSwipe();
        });

        swipeIdInput.addEventListener('blur', function () {
            syncSwipeIdInput();
        });
    }

    // SillyBunny: the sheet has to apply before the rows show, or they change look when it arrives.
    await loadStylesheetAsync(ENTITY_LIST_STYLESHEET.href, { id: ENTITY_LIST_STYLESHEET.id }).catch(error => console.warn('Failed to load the entity list stylesheet:', error));
    await renderSwipeList();

    const popupResult = await popup.show();

    if (branchActionSwipeId !== null) {
        await branchChat(messageId, { swipeId: branchActionSwipeId });
        return;
    }

    if (popupResult !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    if (!canJumpToSwipe) {
        return;
    }

    const targetSwipeId = clamp(selectedSwipeId, 0, message.swipes.length - 1);
    const currentSwipeId = clamp(Number(message.swipe_id ?? 0), 0, message.swipes.length - 1);

    if (targetSwipeId === currentSwipeId) {
        toastr.info(t`Already showing swipe #${targetSwipeId + 1}.`, t`Jump to Swipe`);
        return;
    }

    const direction = targetSwipeId > currentSwipeId ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
    await swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: messageId, forceSwipeId: targetSwipeId });
}

export function initSwipePicker() {
    /**
     * Click handler for opening the swipe picker when clicking on the swipe counter.
     * @param {JQuery.Event | Event} e Event object
     */
    async function onSwipeCounterClick(e) {
        e.preventDefault();
        e.stopPropagation();

        const mesId = Number($(this).closest('.mes').attr('mesid'));
        await openSwipePicker(mesId);
    }

    if (isMobile()) {
        addLongPressEvent('.swipes-counter.swipe-picker-enabled', onSwipeCounterClick);
    } else {
        $(document).on('click', '.swipes-counter.swipe-picker-enabled', onSwipeCounterClick);
    }
    $(document).on('keydown', '.swipes-counter.swipe-picker-enabled', async function (e) {
        if (e.key !== ' ') {
            return;
        }

        onSwipeCounterClick.call(this, e);
    });
    $(document).on('click', '.mes_swipe_picker', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const mesId = Number($(this).closest('.mes').attr('mesid'));
        await openSwipePicker(mesId);
    });
}
