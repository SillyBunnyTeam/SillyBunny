/**
 * @typedef {object} ResponseLengthOverride
 * @property {string} setting Setting that holds the temporary length
 * @property {number} replacedLength Length to write back when no newer override of the setting is in force
 * @property {boolean} hooked Whether an event can remove the override
 */

/**
 * Keeps the temporary response lengths of generations that overlap. A setting holds the length of its newest
 * override. It gets its own value back when its last override is removed, in any order of removal.
 * @param {object} accessors
 * @param {(setting: string) => number} accessors.read Reads the response length of a setting
 * @param {(setting: string, length: number) => void} accessors.write Writes the response length of a setting
 */
export function createResponseLengthOverrides({ read, write }) {
    /** @type {ResponseLengthOverride[]} Overrides in force, oldest first */
    const overrides = [];

    /**
     * @param {ResponseLengthOverride} override Override from add()
     * @returns {boolean} False when the override was not in force
     */
    function remove(override) {
        const index = overrides.indexOf(override);
        if (index === -1) {
            return false;
        }
        overrides.splice(index, 1);
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
         * @returns {ResponseLengthOverride} Override to pass to remove() and hook()
         */
        add(setting, length) {
            const override = { setting, replacedLength: read(setting), hooked: false };
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
         * @param {ResponseLengthOverride} override Override that removeNewestHooked() can remove
         */
        hook(override) {
            override.hooked = true;
        },

        /**
         * Removes one override for an event that does not name its generation. When generations nest, the one
         * that started last reaches the event first.
         * @param {string} setting Setting of the event
         * @returns {boolean} False when the setting had no hooked override
         */
        removeNewestHooked(setting) {
            const override = overrides.findLast(item => item.hooked && item.setting === setting);
            return override ? remove(override) : false;
        },
    };
}
