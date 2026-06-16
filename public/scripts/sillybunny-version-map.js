/**
 * Maps SillyBunny minor versions to their corresponding SillyTavern minor versions.
 * When SB syncs to a new ST minor release, add a new entry to this table.
 * Key: SB minor version (e.g., 6 for SB 1.6.x)
 * Value: ST minor version it tracks (e.g., 18 for ST 1.18.x)
 */
export const SILLYBUNNY_TO_ST_MINOR = {
    6: 18,
};

/**
 * Returns the highest SillyBunny minor version currently mapped in
 * SILLYBUNNY_TO_ST_MINOR, or null if the table is empty.
 * Used as a fallback anchor when a future SillyBunny minor has not yet been
 * explicitly added to the mapping table.
 */
function getMaxMappedSillyBunnyMinor() {
    const mappedMinors = Object.keys(SILLYBUNNY_TO_ST_MINOR).map(Number);
    if (mappedMinors.length === 0) {
        return null;
    }

    return Math.max(...mappedMinors);
}

/**
 * Converts a SillyBunny version string to its SillyTavern equivalent.
 * Used by versionCompare() to check if the current SB version meets extension requirements.
 *
 * When the input minor version is explicitly present in SILLYBUNNY_TO_ST_MINOR,
 * the corresponding SillyTavern minor is used directly.
 *
 * When the input minor version is GREATER than the highest explicitly mapped
 * SillyBunny minor (i.e., a future SillyBunny version that has not yet been added
 * to the mapping table after a version bump), we clamp to the highest synced
 * SillyTavern minor. This preserves extension compatibility for version bumps
 * that do not sync to a new SillyTavern upstream release, avoiding the
 * regression where SB 1.7.0 erroneously compared as smaller than ST 1.18.x.
 *
 * @param {string} version - A semver-like version string (e.g., "1.6.4")
 * @returns {string} The mapped ST version (e.g., "1.18.4"), or the original if no mapping exists
 */
export function mapSillyBunnyVersionToStEquivalent(version) {
    const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (!match) {
        return version;
    }

    const [, major, minor, patch, suffix] = match;
    const numericMajor = Number(major);
    const numericMinor = Number(minor);

    if (numericMajor !== 1 || !Number.isInteger(numericMinor)) {
        return version;
    }

    const explicitMappedMinor = SILLYBUNNY_TO_ST_MINOR[numericMinor];
    if (explicitMappedMinor !== undefined) {
        return `${numericMajor}.${explicitMappedMinor}.${patch}${suffix}`;
    }

    const maxSbMinor = getMaxMappedSillyBunnyMinor();
    if (maxSbMinor === null || numericMinor <= maxSbMinor) {
        return version;
    }

    const maxStMinor = SILLYBUNNY_TO_ST_MINOR[maxSbMinor];
    return `${numericMajor}.${maxStMinor}.${patch}${suffix}`;
}
