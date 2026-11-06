import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config.js';
import { restartCacheClearStatePath } from './helpers/restart-cache-clear-seed.js';
import { DIALOG_SPECS } from './playwright.webkit.config.js';

// The dialog specs of the WebKit config, plus the Welcome and About slides. Current and previous Firefox are a
// supported baseline, and Gecko differs from Chromium in how it navigates, restyles and moves focus.
//
// `welcome-slide-restyles` is not listed: it counts style recalculations in a trace of a Chrome DevTools Protocol
// session, which only Chromium offers. `welcome-transitions` skips its one CDP test (CPU throttling) by itself.
const FIREFOX_SPECS = [...DIALOG_SPECS, 'welcome-transitions'];

// Tests that cannot pass in Playwright's Firefox for a reason that is not a defect of the page. Each pattern is
// matched against the full title, which starts with the spec file name, and across every surface that a spec loops
// over, so a few tests that pass are left out with the ones that fail. The reasons were checked against Firefox and
// Chromium on the same page.
const NOT_RUNNABLE_IN_FIREFOX = [
    {
        // A drag that ends below the viewport edge is clamped there: the sheet stops following the pointer and the
        // pointerup never arrives, so the sheet neither closes nor reaches the drag distance. Chromium delivers both.
        reason: 'sheet-swipe drags past the bottom edge of the viewport, where Firefox delivers no mouse events',
        pattern: /sheet-swipe\.e2e\.js .*(a long swipe closes through the normal path|the exit animation continues from the dragged position|a swipe that starts on the header closes|under reduced motion a long swipe closes at once|mid-drag sheet follows the finger|slides out from the drag position|persona picker keeps one handle)/,
    },
    {
        // `page.setViewportSize()` called before the first navigation never settles in a Firefox context with
        // `isMobile`. `hasTouch` alone is fine, and so is a viewport set after the page has loaded.
        reason: 'the chats archive phone specs call setViewportSize() before the first navigation in an isMobile context',
        pattern: /sillybunny-chats-archive(-layout)?\.e2e\.js .*(390x844|844x390|the phone flow|the selection title on a phone|on a touch phone)/,
    },
    {
        // Gecko serialises a computed font size at 1/64 px, as 13.2031px, where the spec expects 13.2px.
        reason: 'sillybunny-overlays compares a computed font size as the string Chromium produces',
        pattern: /sillybunny-overlays\.e2e\.js .*Chat History moves its live controls into a searchable Window/,
    },
    {
        // After a mouse click, a lone Shift press does not make Gecko treat a later `focus()` as keyboard focus, so
        // `:focus-visible` does not match and the row shows no ring. Chromium counts the Shift press.
        reason: 'the forced colours spec relies on a lone Shift press to make focus() keyboard focus',
        pattern: /Forced colours keep a focus indicator on controls that hide their outline/,
    },
    {
        // Open question, not a verdict. Without browser controls in the window, Tab at the last control of these
        // modals leaves the focus where it is, where Chromium goes on through the document body and wraps. A headed
        // Firefox has to show whether the focus then leaves for the browser's own controls, which a modal allows.
        reason: 'Tab in a modal with no browser controls to take the focus does not wrap',
        pattern: /dialogs-accessibility\.e2e\.js .*(Popup Alert \(destructive confirm\)|Popup Dialog \(form\) over its parent|Chat Archive .*390×844).*keyboard: opens with focus inside/,
    },
];

// Opt-in: `npm run test:e2e:firefox`. The default config stays Chromium only.
export default defineConfig({
    ...baseConfig,
    testMatch: FIREFOX_SPECS.map(name => `**/${name}.e2e.js`),
    grepInvert: NOT_RUNNABLE_IN_FIREFOX.map(({ pattern }) => pattern),
    globalSetup: './helpers/restart-cache-clear-seed.js',
    use: {
        ...baseConfig.use,
        // The restart cache clear reloads the first load of a context, which Gecko's goto() does not wait for.
        storageState: restartCacheClearStatePath(baseConfig.use.baseURL),
    },
    // As in the WebKit config: a request that the app's service worker handles skips `page.route` stubs.
    projects: [{ name: 'firefox', use: { browserName: 'firefox', serviceWorkers: 'block' } }],
});
