/**
 * Scripts to be done before starting the server for the first time.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import chalk from 'chalk';
import { createRequire } from 'node:module';
import { addMissingConfigValues } from './config-init.js';
import { serverDirectory } from './server-directory.js';

/**
 * Colorizes console output.
 */
const color = chalk;

/**
 * Resolves a path relative to the server directory.
 * @param {string} relativePath Relative path.
 * @returns {string} Absolute path.
 */
function resolveServerPath(relativePath) {
    return path.join(serverDirectory, relativePath);
}

/**
 * Copies only missing files from one directory tree into another.
 * This avoids platform-specific recursive copy edge cases when the
 * destination directory structure already exists.
 * @param {string} sourceDirectory
 * @param {string} destinationDirectory
 */
// SillyBunny divergence: initialization syncs ignored default assets without overwriting user files.
function syncMissingDirectoryContents(sourceDirectory, destinationDirectory) {
    if (!fs.existsSync(sourceDirectory)) {
        throw new Error(`Default directory does not exist: ${sourceDirectory}`);
    }

    fs.mkdirSync(destinationDirectory, { recursive: true });

    const dirents = fs.readdirSync(sourceDirectory, { withFileTypes: true });

    for (const dirent of dirents) {
        const sourcePath = path.join(sourceDirectory, dirent.name);
        const destinationPath = path.join(destinationDirectory, dirent.name);

        if (dirent.isDirectory()) {
            syncMissingDirectoryContents(sourcePath, destinationPath);
            continue;
        }

        if (!dirent.isFile()) {
            continue;
        }

        if (!fs.existsSync(destinationPath)) {
            fs.copyFileSync(sourcePath, destinationPath);
        }
    }
}

/**
 * Converts the old config.conf file to the new config.yaml format.
 */
function convertConfig() {
    const oldConfigPath = resolveServerPath('config.conf');
    const currentConfigPath = resolveServerPath('config.yaml');
    const tempConfigPath = resolveServerPath('config.conf.cjs');
    const backupConfigPath = resolveServerPath('config.conf.bak');

    if (fs.existsSync(oldConfigPath)) {
        if (fs.existsSync(currentConfigPath)) {
            console.log(color.yellow('Both config.conf and config.yaml exist. Please delete config.conf manually.'));
            return;
        }

        try {
            console.log(color.blue('Converting config.conf to config.yaml. Your old config.conf will be renamed to config.conf.bak'));
            fs.renameSync(oldConfigPath, tempConfigPath); // Force loading as CommonJS
            const require = createRequire(import.meta.url);
            const config = require(tempConfigPath);
            fs.copyFileSync(tempConfigPath, backupConfigPath);
            fs.rmSync(tempConfigPath);
            fs.writeFileSync(currentConfigPath, yaml.stringify(config));
            console.log(color.green('Conversion successful. Please check your config.yaml and fix it if necessary.'));
        } catch (error) {
            console.error(color.red('FATAL: Config conversion failed. Please check your config.conf file and try again.'), error);
        }
    }
}

/**
 * Creates the default config files if they don't exist yet.
 */
function createDefaultFiles() {
    /**
     * @typedef DefaultItem
     * @type {object}
     * @property {'file' | 'directory'} type - Whether the item should be copied as a single file or merged into a directory structure.
     * @property {string} defaultPath - The path to the default item.
     * @property {string} productionPath - The path to the copied item for production use.
     */

    /** @type {DefaultItem[]} */
    const defaultItems = [
        {
            type: 'file',
            defaultPath: resolveServerPath('default/config.yaml'),
            productionPath: resolveServerPath('config.yaml'),
        },
        {
            type: 'directory',
            defaultPath: resolveServerPath('default/public/'),
            productionPath: resolveServerPath('public/'),
        },
    ];

    for (const defaultItem of defaultItems) {
        try {
            if (defaultItem.type === 'file') {
                if (!fs.existsSync(defaultItem.productionPath)) {
                    fs.copyFileSync(
                        defaultItem.defaultPath,
                        defaultItem.productionPath,
                    );
                    console.log(
                        color.green(`Created default file: ${defaultItem.productionPath}`),
                    );
                }
            } else if (defaultItem.type === 'directory') {
                syncMissingDirectoryContents(defaultItem.defaultPath, defaultItem.productionPath);
                console.log(
                    color.green(`Synchronized missing files: ${defaultItem.productionPath}`),
                );
            } else {
                throw new Error(
                    'FATAL: Unexpected default file format in `server-init.js#createDefaultFiles()`.',
                );
            }
        } catch (error) {
            console.error(
                color.red(
                    `FATAL: Could not write default ${defaultItem.type}: ${defaultItem.productionPath}`,
                ),
                error,
            );
        }
    }
}

try {
    // 0. Convert config.conf to config.yaml
    convertConfig();
    // 1. Create default config files
    createDefaultFiles();
    // 2. Add missing config values
    addMissingConfigValues(resolveServerPath('config.yaml'));
} catch (error) {
    console.error(error);
}
