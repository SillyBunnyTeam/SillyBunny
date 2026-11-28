import { throttle } from './utils.js';

export function initDomHandlers() {
    handleInputWheel();
}

/**
 * Trap mouse wheel inside of focused number inputs to prevent scrolling their containers.
 * Instead of firing wheel events, manually update both slider and input values.
 * This also makes wheel work inside Firefox.
 */
function handleInputWheel() {
    const minInterval = 25; // ms

    /**
     * Update input and slider values based on wheel delta
     * @param {HTMLInputElement} input The number input element
     * @param {HTMLInputElement|null} slider The associated range input element, if any
     * @param {number} deltaY The wheel deltaY value
     */
    function updateValue(input, slider, deltaY) {
        const currentValue = parseFloat(input.value);
        const step = parseFloat(input.step);
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);

        // Sanity checks before trying to calculate new value
        if (isNaN(currentValue) || isNaN(step) || step <= 0 || deltaY === 0) return;

        // Calculate new value based on wheel movement delta (negative = up, positive = down)
        let newValue = currentValue + (deltaY > 0 ? -step : step);
        // Ensure it's a multiple of step
        newValue = Math.round(newValue / step) * step;
        // Ensure it's within the min and max range (NaN-aware)
        newValue = !isNaN(min) ? Math.max(newValue, min) : newValue;
        newValue = !isNaN(max) ? Math.min(newValue, max) : newValue;
        // Simple fix for floating point precision issues
        newValue = Math.round(newValue * 1e10) / 1e10;

        // Update both input and slider values
        input.value = newValue.toString();
        if (slider) slider.value = newValue.toString();
        // Trigger input event (just ONE) to update any listeners
        const inputEvent = new Event('input', { bubbles: true });
        input.dispatchEvent(inputEvent);
    }

    const updateValueThrottled = throttle(updateValue, minInterval);
    // SillyBunny: scope non-passive wheel handling to focused step number inputs via focusin/focusout so document scroll stays compositor-driven.
    /** @type {(() => void) | null} */
    let unbindActiveWheel = null;

    const detachActiveWheel = () => {
        if (unbindActiveWheel) {
            unbindActiveWheel();
            unbindActiveWheel = null;
        }
    };

    document.addEventListener('focusin', (event) => {
        detachActiveWheel();
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches('input[type="number"][step]')) {
            return;
        }

        const input = target;
        const parent = input.closest('.range-block-range-and-counter') ?? input.closest('div') ?? input.parentElement;
        const slider = /** @type {HTMLInputElement|null} */ (parent?.querySelector('input[type="range"]') ?? null);
        const onWheel = (/** @type {WheelEvent} */ e) => {
            if (document.activeElement !== input) {
                detachActiveWheel();
                return;
            }

            if (e.target === input || (slider && e.target === slider)) {
                e.stopPropagation();
                e.preventDefault();
                updateValueThrottled(input, slider, e.deltaY);
            }
        };

        input.addEventListener('wheel', onWheel, { passive: false });
        if (slider && slider !== input) {
            slider.addEventListener('wheel', onWheel, { passive: false });
        }

        unbindActiveWheel = () => {
            input.removeEventListener('wheel', onWheel);
            if (slider && slider !== input) {
                slider.removeEventListener('wheel', onWheel);
            }
        };
    });

    document.addEventListener('focusout', () => {
        detachActiveWheel();
    });
}
