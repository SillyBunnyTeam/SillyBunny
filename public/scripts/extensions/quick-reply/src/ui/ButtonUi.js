import { animation_duration } from '../../../../../script.js';
import { dragElement } from '../../../../RossAscends-mods.js';
import { loadMovingUIState } from '../../../../power-user.js';
import { getUniqueQuickReplySetLinksBySetName } from '../quick-reply-set-list.js';

export class ButtonUi {
    /** @type {QuickReplySettings} */ settings;

    /**@type {HTMLElement}*/ dom;
    /**@type {HTMLElement}*/ popoutDom;
    /**@type {MutationObserver}*/ placementObserver;


    constructor(/**@type {QuickReplySettings}*/settings) {
        this.settings = settings;
    }


    render() {
        if (this.settings.isPopout) {
            return this.renderPopout();
        }
        return this.renderBar();
    }
    unrender() {
        this.stopPlacementObserver();
        this.dom?.remove();
        this.dom = null;
        this.popoutDom?.remove();
        this.popoutDom = null;
    }

    show() {
        if (!this.settings.isEnabled) return;
        if (this.settings.isPopout) {
            document.body.append(this.render());
            loadMovingUIState();
            $(this.render()).fadeIn(animation_duration);
            dragElement($(this.render()));
        } else {
            this.showBar();
        }
    }
    hide() {
        this.unrender();
    }
    refresh() {
        this.hide();
        this.show();
    }

    showBar() {
        const bar = this.render();
        if (this.placeBar(bar)) {
            return;
        }

        this.startPlacementObserver();
    }

    placeBar(/**@type {HTMLElement}*/bar) {
        const sendForm = document.querySelector('#send_form');
        if (!sendForm) {
            return false;
        }

        const nonQrFormItems = document.querySelector('#nonQRFormItems');
        if (nonQrFormItems?.parentElement === sendForm) {
            sendForm.insertBefore(bar, nonQrFormItems);
        } else if (sendForm.firstElementChild) {
            sendForm.insertBefore(bar, sendForm.firstElementChild);
        } else {
            sendForm.append(bar);
        }

        this.stopPlacementObserver();
        return true;
    }

    startPlacementObserver() {
        if (this.placementObserver || typeof MutationObserver === 'undefined' || !document.body) {
            return;
        }

        this.placementObserver = new MutationObserver(() => {
            this.placeBar(this.render());
        });
        this.placementObserver.observe(document.body, { childList: true, subtree: true });
    }

    stopPlacementObserver() {
        this.placementObserver?.disconnect();
        this.placementObserver = null;
    }

    getVisibleSetLinks() {
        return getUniqueQuickReplySetLinksBySetName([
            ...this.settings.config.setList,
            ...(this.settings.chatConfig?.setList ?? []),
            ...(this.settings.charConfig?.setList ?? []),
        ].filter(link => link.isVisible && !link.set?.isDeleted));
    }


    renderBar() {
        if (!this.dom) {
            // SillyBunny: integrations (guided-generations, mobile shell) may move the bar
            // to other hosts; drop any stale instance so the id stays unique when re-rendering.
            document.querySelectorAll('#qr--bar').forEach((el) => el.remove());
            let buttonHolder;
            const root = document.createElement('div'); {
                this.dom = root;
                buttonHolder = root;
                root.id = 'qr--bar';
                root.classList.add('flex-container');
                root.classList.add('flexGap5');
                if (this.settings.showPopoutButton) {
                    root.classList.add('popoutVisible');
                    const popout = document.createElement('div'); {
                        popout.id = 'qr--popoutTrigger';
                        popout.classList.add('menu_button');
                        popout.classList.add('fa-solid');
                        popout.classList.add('fa-window-restore');
                        popout.addEventListener('click', () => {
                            this.settings.isPopout = true;
                            this.refresh();
                            this.settings.save();
                        });
                        root.append(popout);
                    }
                }
                if (this.settings.isCombined) {
                    const buttons = document.createElement('div'); {
                        buttonHolder = buttons;
                        buttons.classList.add('qr--buttons');
                        root.append(buttons);
                    }
                }
                this.getVisibleSetLinks().forEach(link => buttonHolder.append(link.set.render()));
            }
        }
        return this.dom;
    }


    renderPopout() {
        if (!this.popoutDom) {
            let buttonHolder;
            const root = document.createElement('div'); {
                this.popoutDom = root;
                root.id = 'qr--popout';
                root.classList.add('qr--popout');
                root.classList.add('draggable');
                const head = document.createElement('div'); {
                    head.classList.add('qr--header');
                    root.append(head);
                    const controls = document.createElement('div'); {
                        controls.classList.add('qr--controls');
                        controls.classList.add('panelControlBar');
                        controls.classList.add('flex-container');
                        const drag = document.createElement('div'); {
                            drag.id = 'qr--popoutheader';
                            drag.classList.add('fa-solid');
                            drag.classList.add('fa-grip');
                            drag.classList.add('drag-grabber');
                            drag.classList.add('hoverglow');
                            controls.append(drag);
                        }
                        const close = document.createElement('div'); {
                            close.classList.add('qr--close');
                            close.classList.add('fa-solid');
                            close.classList.add('fa-circle-xmark');
                            close.classList.add('hoverglow');
                            close.addEventListener('click', () => {
                                this.settings.isPopout = false;
                                this.refresh();
                                this.settings.save();
                            });
                            controls.append(close);
                        }
                        head.append(controls);
                    }
                }
                const body = document.createElement('div'); {
                    buttonHolder = body;
                    body.classList.add('qr--body');
                    if (this.settings.isCombined) {
                        const buttons = document.createElement('div'); {
                            buttonHolder = buttons;
                            buttons.classList.add('qr--buttons');
                            body.append(buttons);
                        }
                    }
                    this.getVisibleSetLinks().forEach(link => buttonHolder.append(link.set.render()));
                    root.append(body);
                }
            }
        }
        return this.popoutDom;
    }
}
