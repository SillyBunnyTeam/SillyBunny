#!/usr/bin/env node

/**
 * SillyBunny Screenshot Capture Script (Hardened State-Machine Version)
 *
 * Automates screenshot capture for desktop and mobile viewports.
 * Uses a robust drawer state-machine to handle complex desktop/mobile overlays.
 * Requires the SillyBunny server to be running on port 4444.
 */

import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const versionArg = args.find(arg => arg.startsWith('--version='));
const desktopOnly = args.includes('--desktop-only');
const mobileOnly = args.includes('--mobile-only');

if (!versionArg) {
    console.error('Error: --version parameter is required');
    console.error('Usage: node tests/capture-screenshots.js --version=1.6.5');
    process.exit(1);
}

const version = versionArg.split('=')[1];
const baseURL = 'http://127.0.0.1:4444';
const screenshotsDir = join(__dirname, '..', 'screenshots');

// Viewport configurations
const viewports = {
    desktop: { width: 1920, height: 1080 },
    mobile: { width: 390, height: 844 }
};

async function dismissOnboardingIfPresent(page) {
    const onboardingDialog = page.locator('dialog[open]:has(.onboarding)').first();
    if (await onboardingDialog.isVisible().catch(() => false)) {
        await onboardingDialog.locator('.popup-input').fill('Screenshot Tester');
        await onboardingDialog.locator('.popup-button-ok').click({ force: true });
        await page.waitForTimeout(1000);
    }
}

async function forceClick(page, selector) {
    await page.waitForSelector(selector, { state: 'attached', timeout: 10000 });
    try {
        await page.locator(selector).click({ force: true, timeout: 5000 });
    } catch (e) {
        console.log(`      Standard click failed on ${selector}, attempting dispatchEvent...`);
        await page.locator(selector).dispatchEvent('click');
    }
    await page.waitForTimeout(500);
}

// Drawer state machine helper
async function ensureOnlyOpen(page, target) {
    const leftOpen = await page.locator('#left-nav-panel.openDrawer').isVisible().catch(() => false);
    const customizeOpen = await page.locator('#user-settings-block.openDrawer').isVisible().catch(() => false);
    const charactersOpen = await page.locator('#right-nav-panel.openDrawer').isVisible().catch(() => false);

    console.log(`      Current state: Left=${leftOpen}, Customize=${customizeOpen}, Characters=${charactersOpen} -> Targeting: ${target}`);

    if (target === 'left') {
        if (customizeOpen) {
            await forceClick(page, '#sb-right-shell-toggle');
            await page.waitForSelector('#user-settings-block.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (charactersOpen) {
            await forceClick(page, '#sb-character-toggle');
            await page.waitForSelector('#right-nav-panel.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (!leftOpen) {
            await forceClick(page, '#sb-left-shell-toggle');
            await page.waitForSelector('#left-nav-panel.openDrawer', { timeout: 10000 });
        }
    } else if (target === 'customize') {
        if (leftOpen) {
            await forceClick(page, '#sb-left-shell-toggle');
            await page.waitForSelector('#left-nav-panel.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (charactersOpen) {
            await forceClick(page, '#sb-character-toggle');
            await page.waitForSelector('#right-nav-panel.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (!customizeOpen) {
            await forceClick(page, '#sb-right-shell-toggle');
            await page.waitForSelector('#user-settings-block.openDrawer', { timeout: 10000 });
        }
    } else if (target === 'characters') {
        if (leftOpen) {
            await forceClick(page, '#sb-left-shell-toggle');
            await page.waitForSelector('#left-nav-panel.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (customizeOpen) {
            await forceClick(page, '#sb-right-shell-toggle');
            await page.waitForSelector('#user-settings-block.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (!charactersOpen) {
            await forceClick(page, '#sb-character-toggle');
            await page.waitForSelector('#right-nav-panel.openDrawer', { timeout: 10000 });
        }
    } else if (target === 'none') {
        if (leftOpen) {
            await forceClick(page, '#sb-left-shell-toggle');
            await page.waitForSelector('#left-nav-panel.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (customizeOpen) {
            await forceClick(page, '#sb-right-shell-toggle');
            await page.waitForSelector('#user-settings-block.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
        if (charactersOpen) {
            await forceClick(page, '#sb-character-toggle');
            await page.waitForSelector('#right-nav-panel.openDrawer', { state: 'hidden', timeout: 5000 }).catch(() => {});
        }
    }
    await page.waitForTimeout(500);
}

// Screenshot sections configuration
const sections = [
    {
        name: 'navigate',
        description: 'Workspace Presets',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'left');
            // Ensure Presets tab is active
            await forceClick(page, 'button[role="tab"][aria-label="Presets"]');
            await page.waitForTimeout(500);
        }
    },
    {
        name: 'customize',
        description: 'User Settings drawer',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'customize');
            await page.waitForTimeout(500);
        }
    },
    {
        name: 'agents',
        description: 'Workspace Agents tab',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'left');
            // Click Agents tab
            await forceClick(page, 'button[role="tab"][aria-label="Agents"]');
            await page.waitForTimeout(500);
        }
    },
    {
        name: 'characters',
        description: 'Character Management drawer',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'characters');
            await page.waitForTimeout(500);
        }
    },
    {
        name: 'in-chat',
        description: 'Active chat with Assistant',
        setup: async (page) => {
            await ensureOnlyOpen(page, 'none');
            // Check if "Open Assistant" is visible on the Home page, if not click Home toggle
            const isHome = await page.locator('button[data-assistant-id="guide"][data-action="open-assistant"]').first().isVisible().catch(() => false);
            if (!isHome) {
                await forceClick(page, '#sb-home-toggle');
            }
            // Click "Open Assistant"
            const assistantBtn = page.locator('button[data-assistant-id="guide"][data-action="open-assistant"]').first();
            await assistantBtn.click({ force: true, timeout: 5000 }).catch(async () => {
                await assistantBtn.dispatchEvent('click');
            });
            // Wait for chat to load
            await page.waitForSelector('#chat', { state: 'visible', timeout: 10000 });
            await page.waitForTimeout(2000);
        }
    }
];

async function captureScreenshots(viewportType) {
    const viewport = viewports[viewportType];
    console.log(`\n📸 Capturing ${viewportType} screenshots (${viewport.width}x${viewport.height})...`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    try {
        // Navigate to SillyBunny
        console.log(`   Navigating to ${baseURL}...`);
        await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 30000 });

        // Wait for app to initialize
        await page.waitForTimeout(3000);
        await dismissOnboardingIfPresent(page);

        // Capture each section
        for (const section of sections) {
            const filename = `sillybunny-ui-${viewportType}-${section.name}-v${version}.png`;
            const filepath = join(screenshotsDir, filename);

            console.log(`   Capturing ${section.description}...`);

            try {
                // Setup the UI for this screenshot
                await section.setup(page);

                // Take screenshot
                await page.screenshot({
                    path: filepath,
                    fullPage: false,
                    type: 'png'
                });

                console.log(`   ✓ Saved: ${filename}`);
            } catch (error) {
                console.error(`   ✗ Failed to capture ${section.name}: ${error.message}`);
            }
        }
    } catch (error) {
        console.error(`Error during ${viewportType} capture:`, error.message);
        throw error;
    } finally {
        await browser.close();
    }
}

async function main() {
    console.log('🐰 SillyBunny Screenshot Capture Tool');
    console.log(`   Version: ${version}`);
    console.log(`   Output: ${screenshotsDir}`);

    // Check if server is running
    try {
        const response = await fetch(baseURL);
        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }
    } catch (error) {
        console.error(`\n❌ Error: SillyBunny server is not running on ${baseURL}`);
        console.error('   Please start the server first: bun run start');
        process.exit(1);
    }

    try {
        if (!mobileOnly) {
            await captureScreenshots('desktop');
        }

        if (!desktopOnly) {
            await captureScreenshots('mobile');
        }

        console.log('\n✅ Screenshot capture complete!');
        console.log(`   Screenshots saved to: ${screenshotsDir}`);
    } catch (error) {
        console.error('\n❌ Screenshot capture failed:', error.message);
        process.exit(1);
    }
}

main();
