// Curated Chromium PR smoke specs: boot/Home, picking a character, sending and streaming messages,
// changing settings, shared dialogs, desktop/mobile shell, and core browser parity.
export const SMOKE_SPECS = [
    // Boot and Home lifecycle.
    'sample',
    'home-observers',

    // Picking a character and starting a chat.
    'conversation-start-picker',

    // Sending a message, streaming replies, and real chat saves.
    'chat-send-scroll',
    'server-generation-commit',

    // Changing settings through the UI at desktop and phone widths.
    'toast-position-setting',

    // Shared dialogs and desktop/mobile shell smoke.
    'popup-scroll',
    'mobile-shell-smoke',

    // Browser formatting, macro, STscript, and preset event parity.
    'frontend/CoreBrowserParity',
];
