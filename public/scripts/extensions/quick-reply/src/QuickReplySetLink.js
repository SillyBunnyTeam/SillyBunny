import { QuickReplySet } from './QuickReplySet.js';
import { getQuickReplySetLinkNameKey, getQuickReplySetNameKey, getUniqueQuickReplySetsByName } from './quick-reply-set-list.js';

export class QuickReplySetLink {
    static from(props) {
        props.set = QuickReplySet.get(props.set);
        /**@type {QuickReplySetLink}*/
        const instance = Object.assign(new this(), props);
        return instance;
    }


    /**@type {QuickReplySet}*/ set;
    /**@type {Boolean}*/ isVisible = true;

    /**@type {Number}*/ index;

    /**@type {Function}*/ onUpdate;
    /**@type {Function}*/ onRequestEditSet;
    /**@type {Function}*/ onDelete;

    /**@type {HTMLElement}*/ settingsDom;


    renderSettings(idx) {
        this.index = idx;
        const item = document.createElement('div'); {
            this.settingsDom = item;
            // SillyBunny: keep set links as shared rows while preserving sortable and update handlers.
            item.classList.add('qr--item', 'ds-row', 'ds-row--activatable');
            item.setAttribute('data-order', String(this.index));
            const drag = document.createElement('div'); {
                drag.classList.add('drag-handle');
                drag.classList.add('ui-sortable-handle');
                drag.textContent = '☰';
                item.append(drag);
            }
            const set = document.createElement('select'); {
                set.classList.add('qr--set');
                // fix for jQuery sortable breaking childrens' touch events
                set.addEventListener('touchstart', (evt) => evt.stopPropagation());
                set.addEventListener('change', () => {
                    this.set = QuickReplySet.get(set.value);
                    this.update();
                });
                getUniqueQuickReplySetsByName(QuickReplySet.list).toSorted((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())).forEach(qrs => {
                    const opt = document.createElement('option'); {
                        opt.value = qrs.name;
                        opt.textContent = qrs.name;
                        opt.selected = getQuickReplySetNameKey(qrs) === getQuickReplySetLinkNameKey(this);
                        set.append(opt);
                    }
                });
                item.append(set);
            }
            const visible = document.createElement('label'); {
                // SillyBunny: keep the visibility control at the row end with the shared row layout.
                visible.classList.add('qr--visible', 'ds-row-suffix');
                visible.title = 'Show buttons';
                const cb = document.createElement('input'); {
                    cb.type = 'checkbox';
                    cb.checked = this.isVisible;
                    cb.addEventListener('click', () => {
                        this.isVisible = cb.checked;
                        this.update();
                    });
                    visible.append(cb);
                }
                visible.append('Buttons');
                item.append(visible);
            }
            const edit = document.createElement('div'); {
                // SillyBunny: use shared flat controls without changing the existing click handlers.
                edit.classList.add('menu_button');
                edit.classList.add('menu_button_icon', 'sb-header-icon-button');
                edit.classList.add('fa-solid');
                edit.classList.add('fa-pencil');
                edit.title = 'Edit quick reply set';
                edit.addEventListener('click', () => this.requestEditSet());
                item.append(edit);
            }
            const del = document.createElement('div'); {
                del.classList.add('qr--del');
                del.classList.add('menu_button');
                del.classList.add('menu_button_icon', 'sb-header-icon-button');
                del.classList.add('fa-solid');
                del.classList.add('fa-trash-can');
                del.title = 'Remove quick reply set';
                del.addEventListener('click', () => this.delete());
                item.append(del);
            }
        }
        return this.settingsDom;
    }
    unrenderSettings() {
        this.settingsDom?.remove();
        this.settingsDom = null;
    }


    update() {
        if (this.onUpdate) {
            this.onUpdate(this);
        }
    }
    requestEditSet() {
        if (this.onRequestEditSet) {
            this.onRequestEditSet(this.set);
        }
    }
    delete() {
        this.unrenderSettings();
        if (this.onDelete) {
            this.onDelete();
        }
    }


    toJSON() {
        return {
            set: this.set.name,
            isVisible: this.isVisible,
        };
    }
}
