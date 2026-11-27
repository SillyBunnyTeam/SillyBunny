/**
 * Generic Tab Manager for dynamic tab creation and management
 */

export class TabManager {
    constructor(config) {
        this.config = {
            containerSelector: config.containerSelector,
            insertAfterSelector: config.insertAfterSelector,
            insertBeforeSelector: config.insertBeforeSelector, // New option
            useContainerForContent: config.useContainerForContent || false, // New option
            tabPrefix: config.tabPrefix || 'tab',
            activeTabStorageKey: config.activeTabStorageKey,
            defaultTab: config.defaultTab || Object.keys(config.tabs)[0],
            tabs: config.tabs, // { id: { label, icon, contentSelector } }
            checkCondition: config.checkCondition || (() => true),
            onTabSwitch: config.onTabSwitch,
            className: config.className || 'generic-tab',
        };

        this.activeTab = this.config.defaultTab;
        this.tabButtonsContainer = null;
        this.movedElements = new Map();
        this.isTabsCreated = false;
        this.enabled = true;
        // SillyBunny: track event-driven lifecycle hooks and one-shot init timer instead of permanent 2s setInterval polling.
        this.initTimerId = null;
        this.boundCheckCondition = () => this.checkConditionAndInitialize();
        this.lifecycleCleanup = [];
        this.lifecycleAttached = false;

        this.init();
    }

    init() {
        this.attachLifecycleHooks();
        this.initTimerId = setTimeout(() => {
            this.initTimerId = null;
            this.checkConditionAndInitialize();
        }, 300);
    }

    // SillyBunny: react to app/API/preset lifecycle events instead of polling every 2s.
    attachLifecycleHooks() {
        if (this.lifecycleAttached) {
            return;
        }
        this.lifecycleAttached = true;

        const ctx = globalThis.SillyTavern?.getContext?.();
        const eventSource = ctx?.eventSource;
        const eventTypes = ctx?.eventTypes ?? ctx?.event_types;
        const eventNames = [
            eventTypes?.APP_READY,
            eventTypes?.SETTINGS_LOADED_AFTER,
            eventTypes?.MAIN_API_CHANGED,
            eventTypes?.OAI_PRESET_CHANGED_AFTER,
        ].filter(Boolean);

        if (eventSource && typeof eventSource.on === 'function') {
            for (const eventName of eventNames) {
                eventSource.on(eventName, this.boundCheckCondition);
                this.lifecycleCleanup.push(() => {
                    eventSource.removeListener?.(eventName, this.boundCheckCondition);
                });
            }
        }

        if (typeof document !== 'undefined') {
            const onMainApiChange = (event) => {
                if (event?.target?.id === 'main_api') {
                    this.boundCheckCondition();
                }
            };
            document.addEventListener('change', onMainApiChange);
            this.lifecycleCleanup.push(() => document.removeEventListener('change', onMainApiChange));
        }
    }

    detachLifecycleHooks() {
        if (this.initTimerId !== null) {
            clearTimeout(this.initTimerId);
            this.initTimerId = null;
        }
        while (this.lifecycleCleanup.length) {
            const cleanup = this.lifecycleCleanup.pop();
            try {
                cleanup();
            } catch {
                // Ignore teardown errors if context changed.
            }
        }
        this.lifecycleAttached = false;
    }

    setEnabled(enabled) {
        this.enabled = enabled;
        if (!enabled) {
            // SillyBunny: detach lifecycle hooks cleanly when disabled.
            this.detachLifecycleHooks();

            // Force remove tabs immediately when disabled
            if (this.isTabsCreated) {
                this.removeTabs();
            }

            // Double-check removal after a short delay
            setTimeout(() => {
                if (!this.enabled) {
                    this.restoreMovedElements(document.querySelector(this.config.containerSelector));
                    this.forceRemoveAllTabElements();
                }
            }, 100);
        } else if (enabled) {
            // SillyBunny: re-attach event-driven lifecycle hooks when enabled.
            this.attachLifecycleHooks();
            // Check immediately
            this.checkConditionAndInitialize();
        }
    }

    // Force remove all tab-related elements by class name
    forceRemoveAllTabElements() {
        // Remove tab buttons container
        const tabButtons = document.querySelectorAll(`.${this.config.className}-buttons`);
        tabButtons.forEach(el => el.remove());

        this.tabButtonsContainer = null;
        this.isTabsCreated = false;
    }

    checkConditionAndInitialize() {
        if (!this.enabled) {
            // If disabled, ensure tabs are removed
            if (this.isTabsCreated) {
                this.removeTabs();
            }
            return;
        }

        const shouldShowTabs = this.config.checkCondition();

        if (shouldShowTabs && !this.isTabsCreated) {
            this.createTabs();
        } else if (!shouldShowTabs && this.isTabsCreated) {
            this.removeTabs();
        }
    }

    createTabs() {
        // Prevent duplicate creation
        if (document.querySelector(`.${this.config.className}-buttons`)) {
            this.isTabsCreated = true;
            return;
        }

        // Determine where to insert tabs
        let insertElement;
        let insertMethod = 'afterend';

        if (this.config.insertBeforeSelector) {
            insertElement = document.querySelector(this.config.insertBeforeSelector);
            insertMethod = 'beforebegin';
        } else if (this.config.insertAfterSelector) {
            insertElement = document.querySelector(this.config.insertAfterSelector);
            insertMethod = 'afterend';
        }

        if (!insertElement) {
            return;
        }

        // Generate tab buttons HTML
        const tabButtonsHTML = Object.entries(this.config.tabs)
            .map(([id, tab], index) => `
                <button id="${this.config.tabPrefix}-btn-${id}" class="${this.config.className}-button ${index === 0 ? 'active' : ''}" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" aria-controls="${this.config.tabPrefix}-content-${id}" tabindex="${index === 0 ? '0' : '-1'}" type="button">
                    <i class="${tab.icon}"></i>
                    <span data-i18n="${tab.label}">${tab.label}</span>
                </button>
            `).join('');

        insertElement.insertAdjacentHTML(insertMethod, `
            <div class="${this.config.className}-buttons" role="tablist">
                ${tabButtonsHTML}
            </div>
        `);

        this.tabButtonsContainer = document.querySelector(`.${this.config.className}-buttons`);
        this.organizeContent();
        this.bindEvents();
        this.setInitialState();
        this.isTabsCreated = true;
    }

    organizeContent() {
        const tabButtons = this.tabButtonsContainer;
        if (!tabButtons) {
            return;
        }

        if (this.config.useContainerForContent) {
            // For user settings: create tab containers inside the existing container
            const existingContainer = document.querySelector(this.config.containerSelector);
            if (!existingContainer) {
                return;
            }

            // First, collect all elements that need to be moved BEFORE clearing the container
            const elementsToMove = {};
            Object.entries(this.config.tabs).forEach(([id, tab]) => {
                elementsToMove[id] = [];

                tab.contentSelectors.forEach(selector => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(element => {
                        // Find the wrapper (range-block or direct element)
                        const wrapper = element.closest('.range-block') ||
                                       element.closest('[name]') ||
                                       element;

                        if (wrapper && wrapper.parentNode) {
                            elementsToMove[id].push(wrapper);
                        }
                    });
                });
            });

            // Now create tab containers inside the existing container
            const tabContainersHTML = Object.keys(this.config.tabs)
                .map((id, index) => `
                    <div id="${this.config.tabPrefix}-content-${id}" class="${this.config.className}-content ${index === 0 ? 'active' : ''}" role="tabpanel" aria-labelledby="${this.config.tabPrefix}-btn-${id}" ${index === 0 ? '' : 'hidden'}></div>
                `).join('');

            existingContainer.innerHTML = tabContainersHTML;

            // Move collected content to respective tabs
            Object.entries(elementsToMove).forEach(([id, elements]) => {
                const tabContainer = document.querySelector(`#${this.config.tabPrefix}-content-${id}`);
                if (tabContainer) {
                    elements.forEach(element => {
                        if (element && element.parentNode) {
                            tabContainer.appendChild(element);
                        }
                    });
                }
            });
        } else {
            // Original behavior: create tab containers after tab buttons
            const tabContainersHTML = Object.keys(this.config.tabs)
                .map((id, index) => `
                    <div id="${this.config.tabPrefix}-content-${id}" class="${this.config.className}-content ${index === 0 ? 'active' : ''}" role="tabpanel" aria-labelledby="${this.config.tabPrefix}-btn-${id}" ${index === 0 ? '' : 'hidden'}></div>
                `).join('');

            tabButtons.insertAdjacentHTML('afterend', tabContainersHTML);

            // Move content to respective tabs
            Object.entries(this.config.tabs).forEach(([id, tab]) => {
                const tabContainer = document.querySelector(`#${this.config.tabPrefix}-content-${id}`);

                tab.contentSelectors.forEach(selector => {
                    const elements = document.querySelectorAll(selector);
                    elements.forEach(element => {
                        // Find the wrapper (range-block or direct element)
                        const wrapper = element.closest('.range-block') ||
                                       element.closest('[name]') ||
                                       element;

                        if (wrapper && !tabContainer.contains(wrapper) && wrapper.parentNode) {
                            this.trackOriginalPosition(wrapper);
                            tabContainer.appendChild(wrapper);
                        }
                    });
                });
            });
        }
    }

    removeTabs() {
        // Remove tab buttons
        if (this.tabButtonsContainer) {
            this.tabButtonsContainer.remove();
            this.tabButtonsContainer = null;
        }

        const originalContainer = document.querySelector(this.config.containerSelector);

        if (this.config.useContainerForContent && originalContainer) {
            // For user settings: collect all content from tab containers and restore original structure
            const allContent = [];

            // Collect content from all tab containers
            Object.keys(this.config.tabs).forEach(id => {
                const tabContent = document.querySelector(`#${this.config.tabPrefix}-content-${id}`);
                if (tabContent) {
                    while (tabContent.firstChild) {
                        allContent.push(tabContent.firstChild);
                        tabContent.removeChild(tabContent.firstChild);
                    }
                }
            });

            // Remove all tab containers
            Object.keys(this.config.tabs).forEach(id => {
                const tabContent = document.querySelector(`#${this.config.tabPrefix}-content-${id}`);
                if (tabContent) {
                    tabContent.remove();
                }
            });

            // Clear the container and restore all content directly
            originalContainer.innerHTML = '';
            allContent.forEach(element => {
                originalContainer.appendChild(element);
            });
        } else {
            this.restoreMovedElements(originalContainer);
        }

        // Force remove any remaining tab elements
        this.forceRemoveAllTabElements();

        this.isTabsCreated = false;
    }

    bindEvents() {
        document.querySelectorAll(`.${this.config.className}-button`).forEach(button => {
            button.addEventListener('click', (e) => {
                e.preventDefault();
                const tabId = e.target.closest(`.${this.config.className}-button`).id
                    .replace(`${this.config.tabPrefix}-btn-`, '');
                this.switchTab(tabId);
            });

            button.addEventListener('keydown', (e) => this.handleTabKeydown(e));
        });
    }

    trackOriginalPosition(element) {
        if (this.movedElements.has(element)) {
            return;
        }

        this.movedElements.set(element, {
            parent: element.parentNode,
            nextSibling: element.nextSibling,
        });
    }

    restoreMovedElements(fallbackContainer) {
        for (const [element, position] of Array.from(this.movedElements.entries()).reverse()) {
            const parent = position.parent?.isConnected ? position.parent : fallbackContainer;

            if (!element || !parent) {
                continue;
            }

            if (position.nextSibling?.parentNode === parent) {
                parent.insertBefore(element, position.nextSibling);
            } else {
                parent.appendChild(element);
            }
        }

        Object.keys(this.config.tabs).forEach(id => {
            document.querySelector(`#${this.config.tabPrefix}-content-${id}`)?.remove();
        });

        this.movedElements.clear();
    }

    handleTabKeydown(event) {
        const buttons = Array.from(document.querySelectorAll(`.${this.config.className}-button`));
        const currentIndex = buttons.indexOf(event.currentTarget);

        if (currentIndex === -1) {
            return;
        }

        const keyActions = {
            ArrowLeft: () => (currentIndex - 1 + buttons.length) % buttons.length,
            ArrowUp: () => (currentIndex - 1 + buttons.length) % buttons.length,
            ArrowRight: () => (currentIndex + 1) % buttons.length,
            ArrowDown: () => (currentIndex + 1) % buttons.length,
            Home: () => 0,
            End: () => buttons.length - 1,
        };

        const getNextIndex = keyActions[event.key];
        if (!getNextIndex) {
            return;
        }

        event.preventDefault();
        const nextButton = buttons[getNextIndex()];
        const tabId = nextButton.id.replace(`${this.config.tabPrefix}-btn-`, '');
        this.switchTab(tabId);
        nextButton.focus();
    }

    switchTab(tabId) {
        if (!Object.keys(this.config.tabs).includes(tabId)) {
            return;
        }

        // Update buttons
        document.querySelectorAll(`.${this.config.className}-button`).forEach(button => {
            const isActive = button.id === `${this.config.tabPrefix}-btn-${tabId}`;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', String(isActive));
            button.setAttribute('tabindex', isActive ? '0' : '-1');
        });

        // Update content
        document.querySelectorAll(`.${this.config.className}-content`).forEach(content => {
            const isActive = content.id === `${this.config.tabPrefix}-content-${tabId}`;
            content.classList.toggle('active', isActive);
            content.toggleAttribute('hidden', !isActive);
        });

        this.activeTab = tabId;
        this.saveTabPreference(tabId);

        // Call custom callback if provided
        if (this.config.onTabSwitch) {
            this.config.onTabSwitch(tabId);
        }
    }

    setInitialState() {
        const savedTab = this.loadTabPreference();
        const initialTab = Object.keys(this.config.tabs).includes(savedTab) ? savedTab : this.config.defaultTab;
        this.switchTab(initialTab);
    }

    saveTabPreference(tabId) {
        if (!this.config.activeTabStorageKey) {
            return;
        }
        try {
            localStorage.setItem(this.config.activeTabStorageKey, tabId);
        } catch (error) {
            // Silent fail
        }
    }

    loadTabPreference() {
        if (!this.config.activeTabStorageKey) {
            return null;
        }

        try {
            return localStorage.getItem(this.config.activeTabStorageKey);
        } catch (error) {
            return null;
        }
    }

    refreshTabs() {
        if (this.enabled) {
            this.checkConditionAndInitialize();
        }
    }

    // Clean up method to stop all listeners and timers
    destroy() {
        // SillyBunny: detach lifecycle hooks and timers on destroy.
        this.detachLifecycleHooks();
        if (this.isTabsCreated) {
            this.removeTabs();
        }
    }
}
