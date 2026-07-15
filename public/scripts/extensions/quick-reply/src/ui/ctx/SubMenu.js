/**
 * @typedef {import('./MenuItem.js').MenuItem} MenuItem
 */

// Nested Quick Reply menus render in the blocker layer
// so a viewport-sized scrolling parent cannot clip a flipped submenu.
import { clamp, constrainMenuSize, getMenuViewportBounds, syncMenuOverflow } from './MenuViewport.js';

export class SubMenu {
    /**@type {MenuItem[]}*/ itemList = [];
    /**@type {Boolean}*/ isActive = false;

    /**@type {HTMLElement}*/ root;

    /**@type {HTMLElement|null}*/ parent = null;
    /**@type {HTMLElement|null}*/ layer = null;
    /**@type {HTMLElement|null}*/ scrollParent = null;
    /**@type {function|null}*/ viewportResizeHandler = null;
    /**@type {number|null}*/ hideTimer = null;


    constructor(/**@type {MenuItem[]}*/items) {
        this.itemList = items;
    }

    render() {
        if (!this.root) {
            const menu = document.createElement('ul'); {
                this.root = menu;
                menu.classList.add('list-group');
                menu.classList.add('ctx-menu');
                menu.classList.add('ctx-sub-menu');
                this.itemList.forEach(it => menu.append(it.render()));
                menu.addEventListener('mouseenter', () => this.cancelHide());
                menu.addEventListener('mouseleave', event => this.handlePointerLeave(event));
            }
        }
        return this.root;
    }


    cancelHide() {
        if (this.hideTimer !== null) {
            window.clearTimeout(this.hideTimer);
            this.hideTimer = null;
        }
    }

    containsMenuTarget(target) {
        if (!(target instanceof Element)) {
            return false;
        }

        if (this.root?.contains(target)) {
            return true;
        }

        return this.itemList.some(item => item.subMenu?.containsMenuTarget(target));
    }

    isMenuTreeHovered() {
        return Boolean(this.root?.matches(':hover'))
            || this.itemList.some(item => item.subMenu?.isMenuTreeHovered());
    }

    handlePointerLeave(event) {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Element
            && (this.parent?.contains(nextTarget) || this.containsMenuTarget(nextTarget))) {
            return;
        }

        this.cancelHide();
        this.hideTimer = window.setTimeout(() => {
            this.hideTimer = null;
            if (!this.parent?.matches(':hover') && !this.isMenuTreeHovered()) {
                this.hide();
            }
        });
    }


    place() {
        if (!this.isActive || !this.root?.isConnected || !this.parent?.isConnected || !this.layer?.isConnected) {
            return;
        }

        const viewport = getMenuViewportBounds();
        constrainMenuSize(this.root, viewport);
        this.root.style.position = 'absolute';
        this.root.style.top = '0';
        this.root.style.left = '0';
        this.root.style.right = 'auto';
        this.root.style.transform = '';

        const parentRect = this.parent.getBoundingClientRect();
        const scrollParentRect = this.scrollParent?.getBoundingClientRect();
        if (scrollParentRect
            && (parentRect.right <= scrollParentRect.left
                || parentRect.left >= scrollParentRect.right
                || parentRect.bottom <= scrollParentRect.top
                || parentRect.top >= scrollParentRect.bottom)) {
            this.hide();
            return;
        }

        const layerRect = this.layer.getBoundingClientRect();
        const initialRect = this.root.getBoundingClientRect();
        const menuWidth = Math.min(initialRect.width, viewport.width);
        const menuHeight = Math.min(initialRect.height, viewport.height);
        const fitsToRight = parentRect.right + menuWidth <= viewport.right;
        const preferredLeft = fitsToRight ? parentRect.right : parentRect.left - menuWidth;
        const left = clamp(preferredLeft, viewport.left, Math.max(viewport.left, viewport.right - menuWidth));
        const top = clamp(parentRect.top, viewport.top, Math.max(viewport.top, viewport.bottom - menuHeight));

        this.root.style.left = `${Math.round(left - layerRect.left)}px`;
        this.root.style.top = `${Math.round(top - layerRect.top)}px`;
        syncMenuOverflow(this.root);
        this.root.style.visibility = 'visible';
        this.itemList.forEach(item => item.subMenu?.place());
    }

    show(/**@type {HTMLElement}*/parent) {
        if (this.isActive) return;
        this.isActive = true;
        this.parent = parent;
        this.layer = parent.closest('.ctx-blocker') ?? document.body;
        this.scrollParent = parent.closest('.ctx-menu');
        this.render();
        this.root.style.visibility = 'hidden';
        this.layer.append(this.root);
        this.viewportResizeHandler = () => this.place();
        window.addEventListener('resize', this.viewportResizeHandler, { passive: true });
        window.visualViewport?.addEventListener('resize', this.viewportResizeHandler, { passive: true });
        window.visualViewport?.addEventListener('scroll', this.viewportResizeHandler, { passive: true });
        this.scrollParent?.addEventListener('scroll', this.viewportResizeHandler, { passive: true });
        this.place();
    }
    hide() {
        this.cancelHide();
        if (this.viewportResizeHandler) {
            window.removeEventListener('resize', this.viewportResizeHandler);
            window.visualViewport?.removeEventListener('resize', this.viewportResizeHandler);
            window.visualViewport?.removeEventListener('scroll', this.viewportResizeHandler);
            this.scrollParent?.removeEventListener('scroll', this.viewportResizeHandler);
            this.viewportResizeHandler = null;
        }
        this.itemList.forEach(item => item.collapse?.());
        if (this.root) {
            this.root.remove();
            this.root.style.position = '';
            this.root.style.top = '';
            this.root.style.left = '';
            this.root.style.right = '';
            this.root.style.transform = '';
            this.root.style.visibility = '';
        }
        this.parent = null;
        this.layer = null;
        this.scrollParent = null;
        this.isActive = false;
    }
    toggle(/**@type {HTMLElement}*/parent) {
        if (this.isActive) {
            this.hide();
        } else {
            this.show(parent);
        }
    }
}
