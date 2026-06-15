/**
 * SillyBunny Settings Tabs Overhaul
 * Self-contained settings tab layout and search integration.
 */

(function () {
    const tabStyles = `
        /* Tab bar container */
        .sb-settings-tabs-nav {
            display: flex;
            flex-direction: row;
            gap: 8px;
            margin: 12px 0 16px 0;
            border-bottom: 1px solid color-mix(in srgb, var(--sb-shell-border, #cfcfc5) 20%, transparent);
            padding-bottom: 8px;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
        }

        /* Tab buttons */
        .sb-settings-tab-btn {
            background: var(--sb-card-bg, #2f3238);
            color: var(--sb-text-muted, #999992);
            border: 1px solid color-mix(in srgb, var(--sb-shell-border, #cfcfc5) 15%, transparent);
            border-radius: var(--sb-radius-button, 14px);
            padding: 10px 16px;
            font-family: var(--sb-font-display, "Figtree", sans-serif);
            font-size: calc(var(--mainFontSize, 16px) * 0.88);
            font-weight: 700;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease-in-out;
            white-space: nowrap;
        }

        .sb-settings-tab-btn:hover {
            background: var(--sb-bg-hover, #393d41);
            color: var(--sb-text-color, #cfcfc5);
        }

        .sb-settings-tab-btn.active {
            background: var(--sb-primary-accent, #c9c6a8);
            color: var(--sb-shadow-ink, #050607);
            border-color: var(--sb-primary-accent, #c9c6a8);
            box-shadow: 0 4px 12px color-mix(in srgb, var(--sb-primary-accent, #c9c6a8) 25%, transparent);
        }

        /* Content grid layout on desktop */
        @media (min-width: 769px) {
            #user-settings-block-content {
                display: grid !important;
                grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)) !important;
                gap: 16px !important;
                align-items: start !important;
            }

            /* Hide original columns so they don't affect layout boxes */
            [name="UserSettingsFirstColumn"],
            [name="UserSettingsSecondColumn"],
            [name="UserSettingsThirdColumn"] {
                display: contents !important;
            }
        }

        /* Standard responsive fallback for tablet/mobile */
        @media (max-width: 768px) {
            #user-settings-block-content {
                display: flex !important;
                flex-direction: column !important;
                gap: 12px !important;
            }
        }

        /* Declarative visibility rules based on active tab */
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="appearance"] .inline-drawer:not([data-settings-tab="appearance"]),
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="chat-writing"] .inline-drawer:not([data-settings-tab="chat-writing"]),
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="system-device"] .inline-drawer:not([data-settings-tab="system-device"]) {
            display: none !important;
        }

        /* Cache & Account tab visibility: hide all drawers, since there are no drawers under this tab */
        #user-settings-block-content:not([data-search-active="true"])[data-active-tab="cache-account"] .inline-drawer {
            display: none !important;
        }

        /* Hide account controls and cache utility rows unless on Cache & Account tab */
        #user-settings-block:not([data-active-tab="cache-account"]) #account_controls,
        #user-settings-block:not([data-active-tab="cache-account"]) #user-settings-utility-actions {
            display: none !important;
        }

        /* Highlighting of search results inside inactive tabs */
        .highlighted-drawer {
            border-color: var(--sb-primary-accent, #c9c6a8) !important;
            box-shadow: 0 0 10px color-mix(in srgb, var(--sb-primary-accent, #c9c6a8) 30%, transparent) !important;
        }
    `;

    function injectStyles() {
        const style = document.createElement('style');
        style.id = 'sb-settings-tabs-styles';
        style.textContent = tabStyles;
        document.head.appendChild(style);
    }

    function promoteNestedDrawers() {
        // Promote nested subdrawers from AppearanceSection
        const parentAppearance = document.getElementById('AppearanceSection');
        const col1 = document.querySelector('[name="UserSettingsFirstColumn"]');
        if (parentAppearance && col1) {
            // Give parent drawer header a cleaner title
            const mainHeaderSpan = parentAppearance.querySelector(':scope > .inline-drawer-header b span');
            if (mainHeaderSpan) mainHeaderSpan.textContent = 'UI Theme & Presets';

            // Find AppearanceLayoutSection
            const layoutSec = document.getElementById('AppearanceLayoutSection');
            if (layoutSec) {
                col1.appendChild(layoutSec);
            }

            // Find ThemeTogglesSection
            const togglesSec = document.getElementById('ThemeTogglesSection');
            if (togglesSec) {
                col1.appendChild(togglesSec);
            }

            // Find Theme Colors inline-drawer
            const themeColorsDrawer = Array.from(parentAppearance.querySelectorAll('.inline-drawer')).find(drawer => {
                const header = drawer.querySelector('.inline-drawer-header');
                return header && header.textContent.includes('Theme Colors');
            });
            if (themeColorsDrawer) {
                themeColorsDrawer.id = 'sb-theme-colors-drawer';
                col1.appendChild(themeColorsDrawer);
            }
        }

        // Promote nested subdrawers from ChatCharactersSection
        const parentChatCharacters = document.getElementById('ChatCharactersSection');
        const col2 = document.querySelector('[name="UserSettingsSecondColumn"]');
        if (parentChatCharacters && col2) {
            // Find Auto-swipe drawer
            const autoSwipeDrawer = Array.from(parentChatCharacters.querySelectorAll('.inline-drawer')).find(drawer => {
                const header = drawer.querySelector('.inline-drawer-header');
                return header && header.textContent.includes('Auto-swipe');
            });
            if (autoSwipeDrawer) {
                autoSwipeDrawer.id = 'sb-auto-swipe-drawer';
                col2.appendChild(autoSwipeDrawer);
            }

            // Find Auto-Continue drawer
            const autoContinueDrawer = Array.from(parentChatCharacters.querySelectorAll('.inline-drawer')).find(drawer => {
                const header = drawer.querySelector('.inline-drawer-header');
                return header && header.textContent.includes('Auto-Continue');
            });
            if (autoContinueDrawer) {
                autoContinueDrawer.id = 'sb-auto-continue-drawer';
                col2.appendChild(autoContinueDrawer);
            }

            // Find other named nested drawers
            const customCss = document.getElementById('CustomCSS-block');
            if (customCss) col2.appendChild(customCss);

            const googleFont = document.getElementById('GoogleFont-block');
            if (googleFont) col2.appendChild(googleFont);

            const desktopSec = document.getElementById('DesktopSection');
            if (desktopSec) col2.appendChild(desktopSec);

            const mobileSec = document.getElementById('MobileSection');
            if (mobileSec) col2.appendChild(mobileSec);

            const autoComplete = document.querySelector('[name="AutoCompleteToggle"]');
            if (autoComplete) col2.appendChild(autoComplete);
        }

        // Wrap iOS WebKit Streaming Stability in its own inline-drawer
        const iosBlock = document.querySelector('[name="IOSWebKitStreamingToggles"]');
        if (iosBlock && col2 && !document.getElementById('sb-ios-webkit-streaming-drawer')) {
            const iosDrawer = document.createElement('div');
            iosDrawer.id = 'sb-ios-webkit-streaming-drawer';
            iosDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
            iosDrawer.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Controls iPhone and iPad WebKit safeguards for long streamed generations.">
                    <b><i class="fa-solid fa-mobile-screen-button"></i> <span>iOS Streaming Stability</span></b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:none">
                </div>
            `;
            iosBlock.parentNode.insertBefore(iosDrawer, iosBlock);
            iosDrawer.querySelector('.inline-drawer-content').appendChild(iosBlock);
            col2.appendChild(iosDrawer);
        }

        // Wrap Aggressive DOM Unloading in its own inline-drawer
        const domUnloadBlock = document.querySelector('[name="AggressiveDomUnloadToggles"]');
        if (domUnloadBlock && col2 && !document.getElementById('sb-aggressive-dom-unload-drawer')) {
            const domUnloadDrawer = document.createElement('div');
            domUnloadDrawer.id = 'sb-aggressive-dom-unload-drawer';
            domUnloadDrawer.className = 'inline-drawer wide100p flexFlowColumn sb-settings-subdrawer';
            domUnloadDrawer.innerHTML = `
                <div class="inline-drawer-toggle inline-drawer-header userSettingsInnerExpandable" title="Drastically reduces rendered messages to prevent crashes on low-memory devices during long streams.">
                    <b><i class="fa-solid fa-memory"></i> <span>Aggressive DOM Unloading</span></b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content sb-settings-subdrawer-body" style="display:none">
                </div>
            `;
            domUnloadBlock.parentNode.insertBefore(domUnloadDrawer, domUnloadBlock);
            domUnloadDrawer.querySelector('.inline-drawer-content').appendChild(domUnloadBlock);
            col2.appendChild(domUnloadDrawer);
        }
    }

    function tagDrawersWithCategories() {
        const mappings = {
            // Appearance Tab
            'AppearanceSection': 'appearance',
            'sb-theme-colors-drawer': 'appearance',
            'AppearanceLayoutSection': 'appearance',
            'ThemeTogglesSection': 'appearance',
            'CustomCSS-block': 'appearance',
            'GoogleFont-block': 'appearance',

            // Chat & Writing Tab
            'ChatCharactersSection': 'chat-writing',
            'sb-auto-swipe-drawer': 'chat-writing',
            'sb-auto-continue-drawer': 'chat-writing',
            'AutoCompleteToggle': 'chat-writing', // will match name attribute or ID
            'ChatMessageHandlingSection': 'chat-writing',

            // System & Device Tab
            'SillyTavernImportSection': 'system-device',
            'DesktopSection': 'system-device',
            'MobileSection': 'system-device',
            'sb-ios-webkit-streaming-drawer': 'system-device',
            'sb-aggressive-dom-unload-drawer': 'system-device',
        };

        for (const [idOrName, tab] of Object.entries(mappings)) {
            const el = document.getElementById(idOrName) || document.querySelector(`[name="${idOrName}"]`);
            if (el) {
                el.setAttribute('data-settings-tab', tab);
            }
        }
    }

    function createTabBar() {
        const userSettingsContent = document.getElementById('user-settings-block-content');
        if (!userSettingsContent) return;

        // Ensure style and tabs are not duplicated
        if (document.getElementById('sb-settings-tabs')) return;

        const tabNavigation = document.createElement('div');
        tabNavigation.id = 'sb-settings-tabs';
        tabNavigation.className = 'sb-settings-tabs-nav';
        tabNavigation.innerHTML = `
            <button class="sb-settings-tab-btn active" data-tab="appearance">
                <i class="fa-solid fa-palette"></i>
                <span data-i18n="Appearance">Appearance</span>
            </button>
            <button class="sb-settings-tab-btn" data-tab="chat-writing">
                <i class="fa-solid fa-comments"></i>
                <span data-i18n="Chat & Writing">Chat &amp; Writing</span>
            </button>
            <button class="sb-settings-tab-btn" data-tab="system-device">
                <i class="fa-solid fa-laptop-code"></i>
                <span data-i18n="System & Device">System &amp; Device</span>
            </button>
            <button class="sb-settings-tab-btn" data-tab="cache-account">
                <i class="fa-solid fa-user-shield"></i>
                <span data-i18n="Cache & Account">Cache &amp; Account</span>
            </button>
        `;

        userSettingsContent.parentNode.insertBefore(tabNavigation, userSettingsContent);

        // Set default active tab
        userSettingsContent.setAttribute('data-active-tab', 'appearance');
        const settingsBlock = document.getElementById('user-settings-block');
        if (settingsBlock) {
            settingsBlock.setAttribute('data-active-tab', 'appearance');
        }

        // Add event listeners to tab buttons
        tabNavigation.querySelectorAll('.sb-settings-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                tabNavigation.querySelectorAll('.sb-settings-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const tab = btn.getAttribute('data-tab');
                userSettingsContent.setAttribute('data-active-tab', tab);
                if (settingsBlock) {
                    settingsBlock.setAttribute('data-active-tab', tab);
                }
            });
        });
    }

    function setupSearchIntegration() {
        const searchInput = document.getElementById('settingsSearch');
        const content = document.getElementById('user-settings-block-content');

        if (searchInput && content) {
            const handleSearchChange = () => {
                const query = searchInput.value.trim();
                if (query !== '') {
                    content.setAttribute('data-search-active', 'true');
                } else {
                    content.removeAttribute('data-search-active');
                }
            };

            searchInput.addEventListener('input', handleSearchChange);
            searchInput.addEventListener('change', handleSearchChange);
        }
    }

    function initialize() {
        try {
            injectStyles();
            promoteNestedDrawers();
            tagDrawersWithCategories();
            createTabBar();
            setupSearchIntegration();
        } catch (error) {
            console.error('[SillyBunny Settings Tabs] Initialization failed:', error);
        }
    }

    // Poll for the user settings content to be fully loaded
    const pollInterval = setInterval(() => {
        const userSettingsContent = document.getElementById('user-settings-block-content');
        if (userSettingsContent && userSettingsContent.children.length > 0) {
            clearInterval(pollInterval);
            initialize();
        }
    }, 100);
})();
