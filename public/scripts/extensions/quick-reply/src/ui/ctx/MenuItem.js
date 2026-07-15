import { SubMenu } from './SubMenu.js';

export class MenuItem {
    /**@type {string}*/ icon;
    /**@type {boolean}*/ showLabel;
    /**@type {string}*/ label;
    /**@type {string}*/ title;
    /**@type {object}*/ value;
    /**@type {function}*/ callback;
    /**@type {MenuItem[]}*/ childList = [];
    /**@type {SubMenu}*/ subMenu;

    /**@type {HTMLElement}*/ root;

    /**@type {function}*/ onExpand;


    /**
     *
     * @param {?string} icon
     * @param {?boolean} showLabel
     * @param {string} label
     * @param {?string} title Tooltip
     * @param {object} value
     * @param {function} callback
     * @param {MenuItem[]} children
     */
    constructor(icon, showLabel, label, title, value, callback, children = []) {
        this.icon = icon;
        this.showLabel = showLabel;
        this.label = label;
        this.title = title;
        this.value = value;
        this.callback = callback;
        this.childList = children;
    }


    render() {
        if (!this.root) {
            const item = document.createElement('li'); {
                this.root = item;
                item.classList.add('list-group-item');
                item.classList.add('ctx-item');

                // if a title/tooltip is set, add it, otherwise use the QR content
                // same as for the main QR list
                item.title = this.title || this.value;

                if (this.callback) {
                    item.addEventListener('click', (evt) => this.callback(evt, this));
                }
                const icon = document.createElement('div'); {
                    icon.classList.add('qr--button-icon');
                    icon.classList.add('fa-solid');
                    if (!this.icon) icon.classList.add('qr--hidden');
                    else icon.classList.add(this.icon);
                    item.append(icon);
                }
                const lbl = document.createElement('div'); {
                    lbl.classList.add('qr--button-label');
                    if (this.icon && !this.showLabel) lbl.classList.add('qr--hidden');
                    lbl.textContent = this.label;
                    item.append(lbl);
                }
                if (this.childList.length > 0) {
                    // Nested menus are portal-positioned by SubMenu;
                    // defer closing while the pointer crosses into that overlay.
                    item.classList.add('ctx-has-children');
                    const sub = new SubMenu(this.childList);
                    this.subMenu = sub;
                    const trigger = document.createElement('div'); {
                        trigger.classList.add('ctx-expander');
                        trigger.textContent = '⋮';
                        trigger.addEventListener('click', (evt) => {
                            evt.stopPropagation();
                            this.toggle();
                        });
                        item.append(trigger);
                    }
                    item.addEventListener('pointerenter', event => this.expandFromHover(event));
                    item.addEventListener('mouseleave', event => sub.handlePointerLeave(event));
                }
            }
        }
        return this.root;
    }


    expand() {
        this.subMenu?.show(this.root);
        if (this.onExpand) {
            this.onExpand();
        }
    }
    expandFromHover(event) {
        if (event.pointerType === 'mouse') {
            this.expand();
        }
    }
    collapse() {
        this.subMenu?.hide();
    }
    toggle() {
        if (this.subMenu.isActive) {
            this.collapse();
        } else {
            this.expand();
        }
    }
}
