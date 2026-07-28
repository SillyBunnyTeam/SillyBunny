/* global document, HTMLElement, requestAnimationFrame, window, WheelEvent */

export const APP_URL = process.env.SILLYBUNNY_TEST_BASE_URL || '/';

export async function dismissOnboardingIfPresent(page) {
    const openDialog = page.locator('dialog[open]').first();

    await openDialog.waitFor({ state: 'visible', timeout: 2000 }).catch(() => {});

    if (!(await openDialog.isVisible().catch(() => false))) {
        return;
    }

    const dialogText = await openDialog.textContent({ timeout: 1000 }).catch(() => '');
    const onboardingInput = openDialog.locator('textarea.popup-input, input.popup-input, input[type="text"], textarea').first();
    const hasOnboardingInput = await onboardingInput.isVisible().catch(() => false);
    const isWelcomeDialog = /Welcome to SillyBunny/i.test(dialogText ?? '');

    if (!isWelcomeDialog && !hasOnboardingInput) {
        return;
    }

    if (hasOnboardingInput) {
        await onboardingInput.fill('Scroll Tester', { timeout: 1000 }).catch(() => {});
    }

    const okControl = openDialog.locator('.popup-button-ok, [data-result="1"]').first();

    if (await okControl.isVisible().catch(() => false)) {
        await okControl.click({ timeout: 1000 }).catch(() => {});
    } else {
        await page.evaluate(() => {
            document.querySelectorAll('dialog[open]').forEach(dialog => {
                dialog.close();
                dialog.remove();
            });
        });
    }

    await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

export async function dismissOpenDialogIfPresent(page) {
    const openDialog = page.locator('dialog[open]').first();

    await openDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => {});
    await page.evaluate(() => {
        document.querySelectorAll('dialog[open]').forEach(dialog => {
            dialog.close();
            dialog.remove();
        });
    });
    await page.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0, { timeout: 5000 }).catch(() => {});
}

export async function selectSampleCharacter(page) {
    const didSelectCharacter = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();

        if (!context.characters.length) {
            await context.getCharacters();
        }

        const characterId = context.characters.findIndex(character => /Bunny Guide|Seraphina/.test(character?.name ?? character?.data?.name ?? ''));

        if (characterId < 0) {
            return false;
        }

        return context.selectCharacterById(characterId, { switchMenu: false });
    });

    if (!didSelectCharacter) {
        throw new Error('Could not select a sample character for scroll regression setup.');
    }

    const optionalLorebookDecline = page.locator('.popup-button-cancel:visible').first();
    if (await optionalLorebookDecline.isVisible().catch(() => false)) {
        await optionalLorebookDecline.click();
        await page.locator('dialog[open]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }

    await page.locator('#send_textarea').waitFor({ state: 'visible', timeout: 10000 });
}

async function waitForChatRenderIdle(page, { idleMs = 750, timeoutMs = 30000, waitForImages = true } = {}) {
    await page.waitForFunction(() => {
        return typeof window.SillyTavern?.getContext === 'function'
            && document.querySelector('#chat') instanceof HTMLElement;
    }, { timeout: 10000 });

    await page.evaluate(async ({ idleMs: stableIdleMs, timeoutMs: stableTimeoutMs, waitForImages: shouldWaitForImages }) => {
        await new Promise((resolve, reject) => {
            let previousState = '';
            let stableSince = performance.now();
            let settled = false;
            const timeoutId = window.setTimeout(() => {
                settled = true;
                reject(new Error('Chat render did not settle before timeout.'));
            }, stableTimeoutMs);

            const readState = () => {
                const context = window.SillyTavern.getContext();
                const chat = document.querySelector('#chat');
                const messages = Array.from(chat.querySelectorAll('.mes[mesid]'));
                const lastMessage = messages.at(-1);
                const lastMessageRect = lastMessage?.getBoundingClientRect();
                const streamingProcessor = context.streamingProcessor;
                const isStreamActive = Boolean(streamingProcessor && streamingProcessor.isFinished !== true);
                const isGenerationActive = document.body.dataset.generating === 'true';
                const pendingImageCount = shouldWaitForImages
                    ? Array.from(chat.querySelectorAll('img'))
                        .filter(image => !image.complete)
                        .length
                    : 0;

                return JSON.stringify({
                    chatLength: context.chat.length,
                    messageCount: messages.length,
                    firstMesId: messages.at(0)?.getAttribute('mesid') ?? null,
                    lastMesId: messages.at(-1)?.getAttribute('mesid') ?? null,
                    lastMessageTextLength: lastMessage?.textContent?.length ?? 0,
                    lastMessageHeight: lastMessageRect ? Math.round(lastMessageRect.height) : null,
                    chatScrollHeight: chat.scrollHeight,
                    chatClientHeight: chat.clientHeight,
                    isStreamActive,
                    isGenerationActive,
                    pendingImageCount,
                    busyShowMore: chat.querySelector('#show_more_messages[aria-busy="true"]') !== null,
                });
            };

            const checkNextFrame = () => {
                if (settled) {
                    return;
                }

                const now = performance.now();
                const nextState = readState();
                const state = JSON.parse(nextState);

                if (nextState !== previousState
                    || state.isStreamActive
                    || state.isGenerationActive
                    || state.pendingImageCount > 0
                    || state.busyShowMore) {
                    stableSince = now;
                }

                previousState = nextState;

                if (now - stableSince >= stableIdleMs) {
                    settled = true;
                    window.clearTimeout(timeoutId);
                    resolve();
                    return;
                }

                requestAnimationFrame(checkNextFrame);
            };

            checkNextFrame();
        });
    }, { idleMs, timeoutMs, waitForImages });
}

export async function openReadyChat(page, { chatSaveDelayMs = 0, selectCharacter = true } = {}) {
    await page.route('**/api/chats/save', async route => {
        if (chatSaveDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, chatSaveDelayMs));
        }

        await route.fulfill({ status: 200, json: {} });
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    await dismissOnboardingIfPresent(page);
    await dismissOpenDialogIfPresent(page);
    if (selectCharacter) {
        await selectSampleCharacter(page);
    }
    await dismissOpenDialogIfPresent(page);
    await waitForChatRenderIdle(page);
}

async function quietChatForSmoke(page) {
    await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();

        context.stopGeneration?.();

        try {
            const agentRunner = await import('/scripts/extensions/in-chat-agents/agent-runner.js');

            agentRunner.cancelAgentGeneration?.();
        } catch {
            // In-chat agents are optional in smoke profiles.
        }

        const textarea = document.getElementById('send_textarea');
        if (textarea instanceof HTMLElement) {
            textarea.value = '';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

export async function openQuietChatForSmoke(page, options = {}) {
    const { chatSaveDelayMs = 0, selectCharacter = true } = options;

    await page.route('**/api/chats/save', async route => {
        if (chatSaveDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, chatSaveDelayMs));
        }

        await route.fulfill({ status: 200, json: {} });
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    await quietChatForSmoke(page);
    await dismissOnboardingIfPresent(page);
    await dismissOpenDialogIfPresent(page);
    if (selectCharacter) {
        await selectSampleCharacter(page);
    }
    await dismissOpenDialogIfPresent(page);
    await quietChatForSmoke(page);
    await waitForChatRenderIdle(page, { idleMs: 500, timeoutMs: 10000, waitForImages: false });
}

export async function waitForAnimationFrames(page, frameCount = 2) {
    await page.evaluate(async (count) => {
        for (let index = 0; index < count; index++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
    }, frameCount);
}

async function renderSyntheticLongChat(page, { messageCount, visibleCount }) {
    await page.evaluate(async ({ messageCount: syntheticMessageCount, visibleCount: syntheticVisibleCount }) => {
        const context = window.SillyTavern.getContext();
        const chatElement = document.querySelector('#chat');

        context.powerUserSettings.auto_scroll_chat_to_bottom = true;
        context.powerUserSettings.chat_truncation = syntheticVisibleCount;
        context.chat.length = 0;
        chatElement.replaceChildren();

        for (let index = 0; index < syntheticMessageCount; index++) {
            const isUser = index % 2 === 0;
            const baseText = `issue 167 synthetic message ${index}`;
            context.chat.push({
                name: isUser ? 'Scroll Tester' : 'Bunny Guide',
                is_user: isUser,
                is_system: false,
                send_date: new Date(Date.UTC(2024, 0, 1, 0, index)).toISOString(),
                mes: `${baseText}\n${'long chat filler '.repeat(36)}`,
                extra: {},
            });
        }

        await context.printMessages();
    }, { messageCount, visibleCount });
}

function getExpectedSyntheticWindow({ messageCount, visibleCount }) {
    return {
        expectedCount: messageCount,
        expectedVisibleCount: visibleCount,
        expectedFirstMesId: String(Math.max(0, messageCount - visibleCount)),
        expectedLastMesId: String(messageCount - 1),
        expectedRenderedCount: Math.min(messageCount, visibleCount),
    };
}

async function hasSyntheticLongChat(page, expectedWindow) {
    return page.evaluate(({ expectedCount, expectedRenderedCount, expectedFirstMesId, expectedLastMesId }) => {
        const context = window.SillyTavern.getContext();
        const messages = Array.from(document.querySelectorAll('#chat .mes[mesid]'));

        return context.chat.length === expectedCount
            && messages.length === expectedRenderedCount
            && messages.at(0)?.getAttribute('mesid') === expectedFirstMesId
            && messages.at(-1)?.getAttribute('mesid') === expectedLastMesId;
    }, expectedWindow);
}

async function waitForSyntheticLongChat(page, expectedWindow, timeout = 3000) {
    return page.waitForFunction(({ expectedCount, expectedRenderedCount, expectedFirstMesId, expectedLastMesId }) => {
        const context = window.SillyTavern.getContext();
        const messages = Array.from(document.querySelectorAll('#chat .mes[mesid]'));

        return context.chat.length === expectedCount
            && messages.length === expectedRenderedCount
            && messages.at(0)?.getAttribute('mesid') === expectedFirstMesId
            && messages.at(-1)?.getAttribute('mesid') === expectedLastMesId;
    }, expectedWindow, { timeout }).then(() => true).catch(() => false);
}

export async function installSyntheticLongChat(page, { messageCount = 72, visibleCount = messageCount } = {}) {
    const expectedWindow = getExpectedSyntheticWindow({ messageCount, visibleCount });

    for (let attempt = 0; attempt < 3; attempt++) {
        await renderSyntheticLongChat(page, { messageCount, visibleCount });

        if (!(await waitForSyntheticLongChat(page, expectedWindow))) {
            continue;
        }

        await waitForAnimationFrames(page, 6);

        if (await hasSyntheticLongChat(page, expectedWindow)) {
            return;
        }
    }

    throw new Error(`Synthetic long chat did not stabilize at ${messageCount} messages.`);
}

export async function installSwipeCandidate(page, messageId) {
    await page.evaluate((targetMessageId) => {
        const context = window.SillyTavern.getContext();
        const message = context.chat[targetMessageId];

        message.is_user = false;
        message.name = 'Bunny Guide';
        message.swipe_id = 0;
        message.swipes = [
            `issue 167 original swipe ${targetMessageId} ${'anchor filler '.repeat(20)}`,
            `issue 167 replacement swipe ${targetMessageId} ${'replacement filler '.repeat(20)}`,
        ];
        message.swipe_info = message.swipes.map((text, index) => ({
            send_date: new Date(Date.UTC(2024, 0, 1, 1, index)).toISOString(),
            gen_started: null,
            gen_finished: null,
            extra: {},
        }));
        message.mes = message.swipes[0];
        context.addOneMessage(message, { type: 'swipe', forceId: targetMessageId, scroll: false });
    }, messageId);
    await waitForAnimationFrames(page, 2);
}

export async function getChatScrollSnapshot(page) {
    return page.evaluate(() => {
        const chat = document.querySelector('#chat');
        const chatRect = chat.getBoundingClientRect();
        const messages = Array.from(chat.querySelectorAll('.mes[mesid]'));
        const firstVisible = messages.find(message => {
            const rect = message.getBoundingClientRect();
            return rect.bottom > chatRect.top + 1 && rect.top < chatRect.bottom - 1;
        });
        const lastVisible = [...messages].reverse().find(message => {
            const rect = message.getBoundingClientRect();
            return rect.bottom > chatRect.top + 1 && rect.top < chatRect.bottom - 1;
        });
        const lastMessage = messages.at(-1);
        const firstRect = firstVisible?.getBoundingClientRect();
        const lastRect = lastMessage?.getBoundingClientRect();

        return {
            scrollTop: chat.scrollTop,
            scrollHeight: chat.scrollHeight,
            clientHeight: chat.clientHeight,
            bottomDelta: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
            firstVisibleMesId: firstVisible?.getAttribute('mesid') ?? null,
            firstVisibleOffsetTop: firstRect ? firstRect.top - chatRect.top : null,
            lastVisibleMesId: lastVisible?.getAttribute('mesid') ?? null,
            lastMesId: lastMessage?.getAttribute('mesid') ?? null,
            lastMessageBottomDelta: lastRect ? chatRect.bottom - lastRect.bottom : null,
            visibleText: firstVisible?.textContent ?? '',
        };
    });
}

export async function getRenderedMessageIds(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll('#chat .mes[mesid]'))
        .map(message => message.getAttribute('mesid'))
        .filter(Boolean));
}

export async function markFirstRenderedMessageEditing(page) {
    const firstEditButton = page.locator('#chat .mes[mesid] .mes_edit').first();

    await firstEditButton.waitFor({ state: 'visible', timeout: 5000 });
    await firstEditButton.click();
    await page.locator('#chat .mes[mesid] .mes_edit_buttons:visible').first().waitFor({ state: 'visible', timeout: 5000 });
    await waitForAnimationFrames(page, 2);
}

export async function getRedisplayCompatibilitySnapshot(page) {
    return page.evaluate(() => {
        const chat = document.querySelector('#chat');
        const messages = Array.from(chat.querySelectorAll('.mes[mesid]'));
        const firstMessage = messages.at(0);
        const lastMessage = messages.at(-1);

        return {
            renderedMessageIds: messages.map(message => message.getAttribute('mesid')),
            lastMessageId: lastMessage?.getAttribute('mesid') ?? null,
            lastMessageClassCount: chat.querySelectorAll('.mes.last_mes').length,
            fadeClassCount: chat.querySelectorAll('.mes.fade').length,
            stylePinsCount: chat.querySelectorAll(':scope > .style-pins').length,
            firstEditUpDisabled: firstMessage?.querySelector('.mes_edit_up')?.classList.contains('disabled') ?? false,
            firstEditDownDisabled: firstMessage?.querySelector('.mes_edit_down')?.classList.contains('disabled') ?? false,
        };
    });
}

export async function scrollMessageNearTop(page, messageId, offsetTop = 24) {
    await page.waitForFunction((targetMessageId) => {
        return document.querySelector(`#chat .mes[mesid="${targetMessageId}"]`) !== null;
    }, String(messageId), { timeout: 5000 });

    await page.evaluate(({ targetMessageId, targetOffsetTop }) => {
        const chat = document.querySelector('#chat');
        const message = chat.querySelector(`.mes[mesid="${targetMessageId}"]`);
        const chatRect = chat.getBoundingClientRect();
        const messageRect = message.getBoundingClientRect();

        chat.scrollTop += messageRect.top - chatRect.top - targetOffsetTop;
        chat.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, { targetMessageId: String(messageId), targetOffsetTop: offsetTop });
    await waitForAnimationFrames(page, 2);
}

export async function markManualMobileScroll(page, scrollTop) {
    await page.evaluate((nextScrollTop) => {
        const chat = document.querySelector('#chat');

        chat.scrollTop = nextScrollTop;
        chat.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -320 }));
        chat.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, scrollTop);
    await waitForAnimationFrames(page, 2);
}

export async function growMessageBlockAboveViewport(page, messageId, { height = 420 } = {}) {
    await page.evaluate(({ targetMessageId, nextHeight }) => {
        const chat = document.querySelector('#chat');
        const message = chat.querySelector(`.mes[mesid="${targetMessageId}"]`);
        const messageText = message?.querySelector('.mes_text');

        if (!(messageText instanceof HTMLElement)) {
            throw new Error(`Could not find message text for message ${targetMessageId}.`);
        }

        const lateMedia = document.createElement('div');
        lateMedia.className = 'issue-167-late-media';
        lateMedia.style.height = `${nextHeight}px`;
        lateMedia.style.margin = '8px 0';
        lateMedia.style.width = '100%';

        messageText.prepend(lateMedia);
    }, { targetMessageId: String(messageId), nextHeight: height });
    await waitForAnimationFrames(page, 10);
}
