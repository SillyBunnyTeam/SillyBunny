import path from 'node:path';

export function isPathInside(parentPath, candidatePath, { allowEqual = false } = {}) {
    const relativePath = path.relative(parentPath, candidatePath);

    if (!relativePath) {
        return allowEqual;
    }

    return relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);
}
