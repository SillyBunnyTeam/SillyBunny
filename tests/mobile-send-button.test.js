import {
    bindIOSFastTapSendButton,
    isIOSWebKitPlatform,
    isLegacyIOSWebKitPlatform,
    touchEndedInsideElement,
} from '../public/scripts/mobile-send-button.js';

function createTouchEvent(type, x = 10, y = 10) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'changedTouches', {
        value: [{ clientX: x, clientY: y }],
    });
    return event;
}

describe('mobile send button helpers', () => {
    test('detects iOS and iPadOS WebKit platforms', () => {
        expect(isIOSWebKitPlatform({ platform: 'iPhone', maxTouchPoints: 1 })).toBe(true);
        expect(isIOSWebKitPlatform({ platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
        expect(isIOSWebKitPlatform({ platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
        expect(isIOSWebKitPlatform({ platform: 'Linux x86_64', maxTouchPoints: 1 })).toBe(false);
    });

    test('uses the legacy composer viewport only for known iOS versions before 26', () => {
        expect(isLegacyIOSWebKitPlatform({
            platform: 'iPhone',
            maxTouchPoints: 1,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)',
        })).toBe(true);
        expect(isLegacyIOSWebKitPlatform({
            platform: 'iPad',
            maxTouchPoints: 5,
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X)',
        })).toBe(true);
        expect(isLegacyIOSWebKitPlatform({
            platform: 'iPhone',
            maxTouchPoints: 1,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)',
        })).toBe(false);
        expect(isLegacyIOSWebKitPlatform({
            platform: 'iPhone',
            maxTouchPoints: 1,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)',
        })).toBe(false);
        expect(isLegacyIOSWebKitPlatform({
            platform: 'Linux x86_64',
            maxTouchPoints: 1,
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)',
        })).toBe(false);
        expect(isLegacyIOSWebKitPlatform({
            platform: 'MacIntel',
            maxTouchPoints: 5,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        })).toBe(false);
    });

    test('checks whether a touch ended inside the send button', () => {
        const button = { contains: target => target === 'inside' };
        expect(touchEndedInsideElement(createTouchEvent('touchend'), button, {
            elementFromPoint: () => 'inside',
        })).toBe(true);
        expect(touchEndedInsideElement(createTouchEvent('touchend'), button, {
            elementFromPoint: () => 'outside',
        })).toBe(false);
    });

    test('sends on iOS touchend and suppresses the delayed synthetic click', () => {
        const button = new EventTarget();
        button.contains = target => target === button;

        let calls = 0;
        let now = 1000;
        bindIOSFastTapSendButton(button, () => {
            calls += 1;
        }, {
            isIOS: true,
            now: () => now,
            documentRef: { elementFromPoint: () => button },
        });

        button.dispatchEvent(createTouchEvent('touchstart'));
        button.dispatchEvent(createTouchEvent('touchend'));
        button.dispatchEvent(new Event('click', { cancelable: true }));

        expect(calls).toBe(1);

        now = 4000;
        button.dispatchEvent(new Event('click', { cancelable: true }));
        expect(calls).toBe(2);
    });

    test('does not send when the iOS touch ends outside the button', () => {
        const button = new EventTarget();
        button.contains = target => target === button;

        let calls = 0;
        bindIOSFastTapSendButton(button, () => {
            calls += 1;
        }, {
            isIOS: true,
            documentRef: { elementFromPoint: () => 'outside' },
        });

        button.dispatchEvent(createTouchEvent('touchstart'));
        button.dispatchEvent(createTouchEvent('touchend'));

        expect(calls).toBe(0);
    });
});
