/**
 * Maps SillyBunny minor versions to their corresponding SillyTavern minor versions, per SillyBunny major.
 * When SB syncs to a new ST minor release, add a new entry under the SB major that ships it.
 * Key: SB major, then SB minor (e.g., 1 → 6 for SB 1.6.x)
 * Value: ST 1.x minor version it tracks (e.g., 18 for ST 1.18.x)
 */
export const SILLYBUNNY_TO_ST_MINOR_BY_MAJOR = {
    1: {
        6: 18,
        // SB 1.7-1.8 tracked ST staging after the 1.18 release rather than a tagged ST release,
        // so they intentionally clamp to 18 instead of claiming 1.19 compatibility.
    },
    2: {
        0: 19,
    },
};

/**
 * SB 1.x mapping, kept as its own export for existing callers.
 */
export const SILLYBUNNY_TO_ST_MINOR = SILLYBUNNY_TO_ST_MINOR_BY_MAJOR[1];

const ST_MAJOR = 1;

function getMaxKey(table) {
    const keys = Object.keys(table ?? {}).map(Number);
    if (keys.length === 0) {
        return null;
    }

    return Math.max(...keys);
}

/**
 * Converts a SillyBunny version string to its SillyTavern equivalent.
 * Used by versionCompare() to check if the current SB version meets extension requirements.
 *
 * When the input minor version is explicitly mapped for its SB major,
 * the corresponding SillyTavern minor is used directly.
 *
 * When the input minor version is GREATER than the highest explicitly mapped
 * minor for its SB major (i.e., a future SillyBunny version that has not yet been added
 * to the mapping table after a version bump), we clamp to that major's highest synced
 * SillyTavern minor. This preserves extension compatibility for version bumps
 * that do not sync to a new SillyTavern upstream release, avoiding the
 * regression where SB 1.7.0 erroneously compared as smaller than ST 1.18.x.
 *
 * SB majors above the highest mapped major clamp to the newest mapping overall, so an
 * unmapped future major never passes through and satisfies every ST 1.x requirement.
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

    const maxMappedMajor = getMaxKey(SILLYBUNNY_TO_ST_MINOR_BY_MAJOR);
    if (maxMappedMajor === null) {
        return version;
    }

    if (numericMajor > maxMappedMajor) {
        const newestTable = SILLYBUNNY_TO_ST_MINOR_BY_MAJOR[maxMappedMajor];
        const newestStMinor = newestTable[getMaxKey(newestTable)];
        return `${ST_MAJOR}.${newestStMinor}.${patch}${suffix}`;
    }

    const table = SILLYBUNNY_TO_ST_MINOR_BY_MAJOR[numericMajor];
    const maxSbMinor = getMaxKey(table);
    if (maxSbMinor === null) {
        return version;
    }

    const explicitMappedMinor = table[numericMinor];
    if (explicitMappedMinor !== undefined) {
        return `${ST_MAJOR}.${explicitMappedMinor}.${patch}${suffix}`;
    }

    if (numericMinor <= maxSbMinor) {
        return version;
    }

    return `${ST_MAJOR}.${table[maxSbMinor]}.${patch}${suffix}`;
}
