import { QuickReply } from '../../QuickReply.js';
import { QuickReplySet } from '../../QuickReplySet.js';
import { MenuHeader } from './MenuHeader.js';
import { MenuItem } from './MenuItem.js';
// Constrain Quick Reply menus to the visual viewport so
// long/user-positioned menus cannot make actions unreachable on mobile.
import { clamp, constrainMenuSize, getMenuViewportBounds, syncMenuOverflow } from './MenuViewport.js';

export class ContextMenu {
    /**@type {MenuItem[]}*/ itemList = [];
    /**@type {Boolean}*/ isActive = false;

    /**@type {HTMLElement}*/ root;
    /**@type {HTMLElement}*/ menu;

    /**@type {function|null}*/ viewportResizeHandler = null;


    constructor(/**@type {QuickReply}*/qr) {
        // this.itemList = items;
        this.itemList = this.build(qr).children;
        this.itemList.forEach(item => {
            item.onExpand = () => {
                this.itemList.filter(it => it !== item)
                    .forEach(it => it.collapse());
            };
        });
    }

    /**
     * @param {QuickReply} qr
     * @param {String} chainedMessage
     * @param {QuickReplySet[]} hierarchy
     * @param {String[]} labelHierarchy
     */
    build(qr, chainedMessage = null, hierarchy = [], labelHierarchy = []) {
        const tree = {
            icon: qr.icon,
            showLabel: qr.showLabel,
            label: qr.label,
            title: qr.title,
            message: (chainedMessage && qr.message ? `${chainedMessage} | ` : '') + qr.message,
            children: [],
        };
        qr.contextList.forEach((cl) => {
            if (!cl.set) return;
            if (!hierarchy.includes(cl.set)) {
                const nextHierarchy = [...hierarchy, cl.set];
                const nextLabelHierarchy = [...labelHierarchy, tree.label];
                tree.children.push(new MenuHeader(cl.set.name));

                // If the Quick Reply's own set is added as a context menu,
                // show only the sub-QRs that are Invisible but have an icon
                // intent: allow a QR set to be assigned to one of its own QR buttons for a "burger" menu
                // with "UI" QRs either in the bar or in the menu, and "library function" QRs still hidden.
                // - QRs already visible on the bar are filtered out,
                // - hidden QRs without an icon are filtered out,
                // - hidden QRs **with an icon** are shown in the menu
                // so everybody is happy
                const qrsOwnSetAddedAsContextMenu = cl.set.qrList.includes(qr);
                const visible = (subQr) => {
                    return qrsOwnSetAddedAsContextMenu
                        ? subQr.isHidden && !!subQr.icon  // yes .isHidden gets inverted here
                        : !subQr.isHidden;
                };

                cl.set.qrList.filter(visible).forEach(subQr => {
                    const subTree = this.build(subQr, cl.isChained ? tree.message : null, nextHierarchy, nextLabelHierarchy);
                    tree.children.push(new MenuItem(
                        subTree.icon,
                        subTree.showLabel,
                        subTree.label,
                        subTree.title,
                        subTree.message,
                        (evt) => {
                            evt.stopPropagation();
                            const finalQr = Object.assign(new QuickReply(), subQr);
                            finalQr.message = subTree.message.replace(/%%parent(-\d+)?%%/g, (_, index) => {
                                return nextLabelHierarchy.slice(parseInt(index ?? '-1'))[0];
                            });
                            cl.set.execute(finalQr);
                        },
                        subTree.children,
                    ));
                });
            }
        });
        return tree;
    }

    render() {
        if (!this.root) {
            const blocker = document.createElement('div'); {
                this.root = blocker;
                blocker.classList.add('ctx-blocker');
                blocker.addEventListener('click', () => this.hide());
                const menu = document.createElement('ul'); {
                    this.menu = menu;
                    menu.classList.add('list-group');
                    menu.classList.add('ctx-menu');
                    this.itemList.forEach(it => menu.append(it.render()));
                    blocker.append(menu);
                }
            }
        }
        return this.root;
    }


    place(clientX, clientY) {
        if (!this.menu?.isConnected) {
            return;
        }

        const viewport = getMenuViewportBounds();
        constrainMenuSize(this.menu, viewport);

        const measuredRect = this.menu.getBoundingClientRect();
        const menuWidth = Math.min(measuredRect.width, viewport.width);
        const menuHeight = Math.min(measuredRect.height, viewport.height);
        const left = clamp(clientX, viewport.left, Math.max(viewport.left, viewport.right - menuWidth));
        const top = clamp(clientY - menuHeight, viewport.top, Math.max(viewport.top, viewport.bottom - menuHeight));

        this.menu.style.left = `${Math.round(left)}px`;
        this.menu.style.top = `${Math.round(top)}px`;
        this.menu.style.right = 'auto';
        this.menu.style.bottom = 'auto';
        syncMenuOverflow(this.menu);
        this.menu.style.visibility = 'visible';
    }


    show({ clientX, clientY }) {
        if (this.isActive) return;
        this.isActive = true;
        this.render();
        this.menu.style.visibility = 'hidden';
        document.body.append(this.root);
        this.place(clientX, clientY);

        this.viewportResizeHandler = () => this.place(clientX, clientY);
        window.addEventListener('resize', this.viewportResizeHandler, { passive: true });
        window.visualViewport?.addEventListener('resize', this.viewportResizeHandler, { passive: true });
        window.visualViewport?.addEventListener('scroll', this.viewportResizeHandler, { passive: true });
    }
    hide() {
        this.itemList.forEach(item => item.collapse?.());
        if (this.viewportResizeHandler) {
            window.removeEventListener('resize', this.viewportResizeHandler);
            window.visualViewport?.removeEventListener('resize', this.viewportResizeHandler);
            window.visualViewport?.removeEventListener('scroll', this.viewportResizeHandler);
            this.viewportResizeHandler = null;
        }
        if (this.root) {
            this.root.remove();
        }
        this.isActive = false;
    }
    toggle(/**@type {PointerEvent}*/evt) {
        if (this.isActive) {
            this.hide();
        } else {
            this.show(evt);
        }
    }
}
