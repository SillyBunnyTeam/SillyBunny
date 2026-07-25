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
    console.log(`Usage: node scripts/bump-agent-template-versions.js [--dry-run] [--file <path>]...

Bumps changed bundled in-chat agent template versions based on Git file changes.

Options:
  --dry-run       Show what would be bumped without writing files.
  --file <path>   Check a specific template JSON file or index.json entry source.
  --help          Show this help message.

When no --file is provided, changed files under ${templatesDirRel} are detected from git status.
Version-only changes are ignored; template content changes are bumped to HEAD version + 1.`);
}

function parseArgs(argv) {
    const options = {
        dryRun: false,
        files: [],
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }

        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        if (arg === '--file' || arg === '-f') {
            const file = argv[index + 1];
            if (!file) {
                throw new Error('Missing value for --file.');
            }
            options.files.push(file);
            index += 1;
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
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

function getChangedFilesFromGit() {
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

function readHeadJson(relativePath) {
    try {
        const content = execFileSync('git', ['show', `HEAD:${relativePath}`], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return JSON.parse(content);
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

function collectIndividualTemplateTarget(filePath, versionTargets) {
    const relativePath = getRelativePath(filePath);

    if (!fs.existsSync(filePath)) {
        console.log(`Skipping removed template ${relativePath}.`);
        return;
    }

    const currentTemplate = readJsonFile(filePath);
    const baseTemplate = readHeadJson(relativePath);

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

    const targetVersion = getTemplateVersion(baseTemplate, `HEAD:${relativePath}`) + 1;
    addVersionTarget(versionTargets, currentTemplate.id, targetVersion, relativePath);
}

function getEntriesById(templates) {
    return new Map(
        templates
            .filter(template => template?.id)
            .map(template => [template.id, template]),
    );
}

function collectIndexTargets(versionTargets) {
    if (!fs.existsSync(indexPath)) {
        return;
    }

    const currentEntries = readJsonFile(indexPath);
    const baseEntries = readHeadJson(indexRel);

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

        const targetVersion = getTemplateVersion(baseEntry, `HEAD:${indexRel} entry ${currentEntry.id}`) + 1;
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

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printHelp();
        return;
    }

    const inputFiles = options.files.length > 0
        ? options.files.map(resolveFileArg)
        : getChangedFilesFromGit();

    const candidateFiles = [...new Set(inputFiles.map(filePath => path.resolve(filePath)))];
    const versionTargets = new Map();

    for (const filePath of candidateFiles) {
        if (getRelativePath(filePath) === indexRel) {
            continue;
        }

        if (isTemplateJsonPath(filePath)) {
            collectIndividualTemplateTarget(filePath, versionTargets);
        }
    }

    const shouldCollectIndexTargets = options.files.length === 0 ||
        candidateFiles.some(filePath => getRelativePath(filePath) === indexRel);
    if (shouldCollectIndexTargets) {
        collectIndexTargets(versionTargets);
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
