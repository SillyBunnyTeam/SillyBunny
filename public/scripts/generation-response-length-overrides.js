/**
 * @typedef {object} ResponseLengthOverride
 * @property {string} setting Setting that holds the temporary length
 * @property {number} replacedLength Length to write back when no newer override of the setting is in force
 */

/**
 * Keeps the temporary response lengths of generations that overlap. A setting holds the length of its newest
 * override. It gets its own value back when its last override is removed, in any order of removal. A value that
 * other code writes to the setting while an override is in force is lost when that override is removed.
 * @param {object} accessors
 * @param {(setting: string) => number} accessors.read Reads the response length of a setting
 * @param {(setting: string, length: number) => void} accessors.write Writes the response length of a setting
 */
export function createResponseLengthOverrides({ read, write }) {
    /** @type {ResponseLengthOverride[]} Overrides in force, oldest first */
    const overrides = [];
    /** @type {ResponseLengthOverride[]} Overrides that wait for an event, in the order they started to wait */
    const hooked = [];

    /**
     * @param {ResponseLengthOverride} override Override to remove
     * @returns {boolean} False when the override was not in force
     */
    function remove(override) {
        const index = overrides.indexOf(override);
        if (index === -1) {
            return false;
        }
        overrides.splice(index, 1);
        const hookIndex = hooked.indexOf(override);
        if (hookIndex !== -1) {
            hooked.splice(hookIndex, 1);
        }
        const newer = overrides.slice(index).find(item => item.setting === override.setting);
        if (newer) {
            // The setting keeps the length of the newer override, which replaced this one.
            newer.replacedLength = override.replacedLength;
        } else {
            write(override.setting, override.replacedLength);
        }
        return true;
    }

    return {
        isActive: () => overrides.length > 0,

        /**
         * @param {string} setting Setting to override
         * @param {number} length Temporary response length
         * @returns {ResponseLengthOverride} Override of the caller
         */
        add(setting, length) {
            const override = { setting, replacedLength: read(setting) };
            write(setting, length);
            overrides.push(override);
            return override;
        },

        remove,

        removeAll() {
            while (overrides.length) {
                remove(overrides.at(-1));
            }
        },

        /**
         * @param {ResponseLengthOverride} override Override that an event can remove from now on
         */
        hook(override) {
            if (overrides.includes(override) && !hooked.includes(override)) {
                hooked.push(override);
            }
        },

        /**
         * Removes one override for an event that does not name its generation: the one that started to wait
         * last. A generation that runs inside another one starts to wait last and reaches the event first, and
         * so does a generation that starts to wait just before it builds its request data.
         * @param {string} setting Setting of the event
         * @returns {boolean} False when no override of the setting waited
         */
        removeNewestHooked(setting) {
            const override = hooked.findLast(item => item.setting === setting);
            return override ? remove(override) : false;
        },
    };
}
