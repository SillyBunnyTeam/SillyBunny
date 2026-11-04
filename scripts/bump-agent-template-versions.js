#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const templatesDir = path.join(repoRoot, 'public/scripts/extensions/in-chat-agents/templates');
const templatesDirRel = 'public/scripts/extensions/in-chat-agents/templates';
const indexPath = path.join(templatesDir, 'index.json');
const indexRel = `${templatesDirRel}/index.json`;
const skippedTemplateFiles = new Set(['groups.json', 'index.json', 'regex-bundles.json']);

function printHelp() {
    console.log(`Usage: node scripts/bump-agent-template-versions.js [--dry-run] [--base <ref>] [--file <path>]...
       node scripts/bump-agent-template-versions.js --check --base <ref> [--head <ref>]

Bumps changed bundled in-chat agent template versions based on Git file changes.

Options:
  --dry-run       Show what would be bumped without writing files.
  --file <path>   Check a specific template JSON file or index.json entry source.
  --base <ref>    Compare against this commit instead of HEAD.
  --check         Write nothing; exit with an error when a template changed between
                  --base and --head without a version bump.
  --head <ref>    Commit to check with --check. Defaults to HEAD.
  --help          Show this help message.

When no --file is provided, changed files under ${templatesDirRel} are detected from git
(git status against HEAD, or git diff against --base).
Version-only changes are ignored; template content changes are bumped to base version + 1.`);
}

function readOptionValue(argv, index, name) {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
        throw new Error(`Missing value for ${name}.`);
    }
    return value;
}

function parseArgs(argv) {
    const options = {
        dryRun: false,
        check: false,
        base: null,
        head: null,
        files: [],
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }

        if (arg === '--check') {
            options.check = true;
            continue;
        }

        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        if (arg === '--file' || arg === '-f') {
            options.files.push(readOptionValue(argv, index, '--file'));
            index += 1;
            continue;
        }

        if (arg === '--base' || arg === '--head') {
            options[arg.slice(2)] = readOptionValue(argv, index, arg);
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    if (options.check && !options.base) {
        throw new Error('--check needs --base <ref>.');
    }

    if (options.check && (options.dryRun || options.files.length > 0)) {
        throw new Error('--check cannot be combined with --dry-run or --file.');
    }

    if (options.head && !options.check) {
        throw new Error('--head works only with --check.');
    }

    return options;
}

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

function getRelativePath(filePath) {
    return toPosixPath(path.relative(repoRoot, filePath));
}

function isTemplateJsonPath(filePath) {
    const absolutePath = path.resolve(filePath);
    const relativePath = getRelativePath(absolutePath);
    const basename = path.basename(absolutePath);

    return relativePath.startsWith(`${templatesDirRel}/`) &&
        relativePath.endsWith('.json') &&
        !skippedTemplateFiles.has(basename);
}

function resolveFileArg(fileArg) {
    const directPath = path.isAbsolute(fileArg)
        ? fileArg
        : path.resolve(repoRoot, fileArg);

    if (fs.existsSync(directPath)) {
        return directPath;
    }

    const templatePath = path.join(templatesDir, fileArg);
    if (fs.existsSync(templatePath)) {
        return templatePath;
    }

    throw new Error(`Template file not found: ${fileArg}`);
}

function git(args) {
    return execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}

function resolveCommit(ref, optionName) {
    try {
        return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
    } catch {
        throw new Error(`${optionName} ${ref} is not a commit.`);
    }
}

function getChangedFilesFromGit(baseCommit) {
    if (baseCommit) {
        return git(['diff', '--name-only', '--no-renames', baseCommit, '--', templatesDirRel])
            .split('\n')
            .filter(Boolean)
            .map(filePath => path.resolve(repoRoot, filePath));
    }

    const output = execFileSync('git', ['status', '--porcelain', '--', templatesDirRel], {
        cwd: repoRoot,
        encoding: 'utf8',
    }).trim();

    if (!output) {
        return [];
    }

    return output
        .split('\n')
        .map(line => line.slice(3).trim())
        .map(filePath => filePath.includes(' -> ') ? filePath.split(' -> ').pop() : filePath)
        .map(filePath => path.resolve(repoRoot, filePath));
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readGitJson(ref, relativePath) {
    try {
        return JSON.parse(git(['show', `${ref}:${relativePath}`]));
    } catch {
        return null;
    }
}

function stableValue(value) {
    if (Array.isArray(value)) {
        return value.map(stableValue);
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
                .map(([key, entryValue]) => [key, stableValue(entryValue)]),
        );
    }

    return value;
}

function withoutVersion(template) {
    const comparable = structuredClone(template);
    delete comparable.version;
    return stableValue(comparable);
}

function hasTemplateContentChanged(currentTemplate, baseTemplate) {
    if (!baseTemplate) {
        return false;
    }

    return JSON.stringify(withoutVersion(currentTemplate)) !== JSON.stringify(withoutVersion(baseTemplate));
}

function getTemplateVersion(template, label) {
    const version = Number(template?.version);
    if (!Number.isInteger(version) || version < 1) {
        throw new Error(`${label} has an invalid version value.`);
    }
    return version;
}

function addVersionTarget(versionTargets, templateId, targetVersion, source) {
    const existing = versionTargets.get(templateId);

    if (existing && existing.targetVersion !== targetVersion) {
        throw new Error(`Conflicting version targets for ${templateId}: ${existing.targetVersion} from ${existing.source}, ${targetVersion} from ${source}.`);
    }

    versionTargets.set(templateId, {
        targetVersion,
        source: existing ? `${existing.source}, ${source}` : source,
    });
}

function collectIndividualTemplateTarget(filePath, versionTargets, baseRef) {
    const relativePath = getRelativePath(filePath);

    if (!fs.existsSync(filePath)) {
        console.log(`Skipping removed template ${relativePath}.`);
        return;
    }

    const currentTemplate = readJsonFile(filePath);
    const baseTemplate = readGitJson(baseRef, relativePath);

    if (!baseTemplate) {
        console.log(`Skipping new template ${relativePath}; new templates should start at their declared version.`);
        return;
    }

    if (!currentTemplate?.id) {
        throw new Error(`${relativePath} is missing an id.`);
    }

    if (!hasTemplateContentChanged(currentTemplate, baseTemplate)) {
        return;
    }

    const targetVersion = getTemplateVersion(baseTemplate, `${baseRef}:${relativePath}`) + 1;
    addVersionTarget(versionTargets, currentTemplate.id, targetVersion, relativePath);
}

function getEntriesById(templates) {
    return new Map(
        templates
            .filter(template => template?.id)
            .map(template => [template.id, template]),
    );
}

function collectIndexTargets(versionTargets, baseRef) {
    if (!fs.existsSync(indexPath)) {
        return;
    }

    const currentEntries = readJsonFile(indexPath);
    const baseEntries = readGitJson(baseRef, indexRel);

    if (!Array.isArray(currentEntries) || !Array.isArray(baseEntries)) {
        return;
    }

    const baseEntriesById = getEntriesById(baseEntries);

    for (const currentEntry of currentEntries) {
        if (!currentEntry?.id) {
            continue;
        }

        const baseEntry = baseEntriesById.get(currentEntry.id);
        if (!baseEntry || !hasTemplateContentChanged(currentEntry, baseEntry)) {
            continue;
        }

        const targetVersion = getTemplateVersion(baseEntry, `${baseRef}:${indexRel} entry ${currentEntry.id}`) + 1;
        addVersionTarget(versionTargets, currentEntry.id, targetVersion, indexRel);
    }
}

function writeJsonFile(filePath, value, spaces) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, spaces)}\n`);
}

function applyTemplateVersion(template, targetVersion, label, dryRun) {
    const currentVersion = getTemplateVersion(template, label);

    if (currentVersion === targetVersion) {
        console.log(`${label} is already at v${targetVersion}.`);
        return false;
    }

    if (currentVersion > targetVersion) {
        console.log(`${label} is already above target version v${targetVersion}; leaving v${currentVersion}.`);
        return false;
    }

    if (dryRun) {
        console.log(`Would bump ${label}: v${currentVersion} -> v${targetVersion}.`);
        return false;
    }

    template.version = targetVersion;
    console.log(`Bumped ${label}: v${currentVersion} -> v${targetVersion}.`);
    return true;
}

function applyVersions(versionTargets, dryRun) {
    const templateFiles = fs.readdirSync(templatesDir)
        .filter(fileName => isTemplateJsonPath(path.join(templatesDir, fileName)))
        .map(fileName => path.join(templatesDir, fileName));

    for (const filePath of templateFiles) {
        const template = readJsonFile(filePath);
        const target = template?.id ? versionTargets.get(template.id) : null;
        if (!target) {
            continue;
        }

        if (applyTemplateVersion(template, target.targetVersion, getRelativePath(filePath), dryRun)) {
            writeJsonFile(filePath, template, 4);
        }
    }

    const indexEntries = readJsonFile(indexPath);
    let indexChanged = false;

    for (const entry of indexEntries) {
        const target = entry?.id ? versionTargets.get(entry.id) : null;
        if (!target) {
            continue;
        }

        indexChanged = applyTemplateVersion(entry, target.targetVersion, `${indexRel} entry ${entry.id}`, dryRun) || indexChanged;
    }

    if (indexChanged) {
        writeJsonFile(indexPath, indexEntries, 4);
    }
}

function findUnbumpedTemplates(baseCommit, headCommit) {
    const problems = [];
    const requireBump = (label, currentTemplate, baseTemplate) => {
        if (!hasTemplateContentChanged(currentTemplate, baseTemplate)) {
            return;
        }

        const baseVersion = getTemplateVersion(baseTemplate, `${label} at --base`);
        const currentVersion = getTemplateVersion(currentTemplate, `${label} at --head`);
        if (currentVersion <= baseVersion) {
            problems.push(`${label} changed but stays at v${currentVersion}; it needs at least v${baseVersion + 1}.`);
        }
    };

    const changedPaths = git(['diff', '--name-only', '--no-renames', baseCommit, headCommit, '--', templatesDirRel])
        .split('\n')
        .filter(Boolean);

    for (const relativePath of changedPaths) {
        if (relativePath === indexRel) {
            const currentEntries = readGitJson(headCommit, indexRel);
            const baseEntries = readGitJson(baseCommit, indexRel);
            if (!Array.isArray(currentEntries) || !Array.isArray(baseEntries)) {
                continue;
            }

            const baseEntriesById = getEntriesById(baseEntries);
            for (const currentEntry of currentEntries) {
                const baseEntry = currentEntry?.id ? baseEntriesById.get(currentEntry.id) : null;
                if (baseEntry) {
                    requireBump(`${indexRel} entry ${currentEntry.id}`, currentEntry, baseEntry);
                }
            }
            continue;
        }

        if (!isTemplateJsonPath(path.resolve(repoRoot, relativePath))) {
            continue;
        }

        const currentTemplate = readGitJson(headCommit, relativePath);
        const baseTemplate = readGitJson(baseCommit, relativePath);
        if (currentTemplate && baseTemplate) {
            requireBump(relativePath, currentTemplate, baseTemplate);
        }
    }

    return problems;
}

function runCheck(options) {
    const baseCommit = resolveCommit(options.base, '--base');
    const headCommit = resolveCommit(options.head ?? 'HEAD', '--head');
    const problems = findUnbumpedTemplates(baseCommit, headCommit);

    if (problems.length === 0) {
        console.log('Bundled agent template versions are up to date.');
        return;
    }

    for (const problem of problems) {
        console.error(problem);
    }
    console.error(`Bump them with \`npm run agents:bump-template-versions -- --base ${options.base}\` and commit the result.`);
    process.exitCode = 1;
}

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printHelp();
        return;
    }

    if (options.check) {
        runCheck(options);
        return;
    }

    const baseCommit = options.base ? resolveCommit(options.base, '--base') : null;
    const baseRef = baseCommit ?? 'HEAD';
    const inputFiles = options.files.length > 0
        ? options.files.map(resolveFileArg)
        : getChangedFilesFromGit(baseCommit);

    const candidateFiles = [...new Set(inputFiles.map(filePath => path.resolve(filePath)))];
    const versionTargets = new Map();

    for (const filePath of candidateFiles) {
        if (getRelativePath(filePath) === indexRel) {
            continue;
        }

        if (isTemplateJsonPath(filePath)) {
            collectIndividualTemplateTarget(filePath, versionTargets, baseRef);
        }
    }

    const shouldCollectIndexTargets = options.files.length === 0 ||
        candidateFiles.some(filePath => getRelativePath(filePath) === indexRel);
    if (shouldCollectIndexTargets) {
        collectIndexTargets(versionTargets, baseRef);
    }

    if (versionTargets.size === 0) {
        console.log('No bundled agent template content changes need version bumps.');
        return;
    }

    applyVersions(versionTargets, options.dryRun);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
