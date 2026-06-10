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
 * Converts a SillyBunny version string to its SillyTavern equivalent.
 * Used by versionCompare() to check if the current SB version meets extension requirements.
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

    const mappedMinor = SILLYBUNNY_TO_ST_MINOR[numericMinor];
    if (mappedMinor === undefined) {
        return version;
    }

    return `${numericMajor}.${mappedMinor}.${patch}${suffix}`;
}
