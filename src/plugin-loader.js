import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import express from 'express';
import { default as git, CheckRepoActions } from 'simple-git';
import { sync as commandExistsSync } from 'command-exists';
import { getConfig, getConfigValue, color } from './util.js';
import {
    SERVER_PLUGIN_BACKUP_DIRECTORY,
    SERVER_PLUGIN_RELEASE_MARKER,
    SERVER_PLUGIN_UPDATE_DIRECTORY,
} from './server-plugin-manager.js';

const SERVER_PLUGINS_CONFIG_KEY = 'enableServerPlugins';
const COMMON_SERVER_PLUGIN_CONFIG_MISTAKES = ['enableServerPlugin', 'enableserverplugin', 'enableserverplugins'];
const RESERVED_PLUGIN_ENTRIES = new Set([SERVER_PLUGIN_UPDATE_DIRECTORY, SERVER_PLUGIN_BACKUP_DIRECTORY]);

const enableServerPlugins = !!getConfigValue(SERVER_PLUGINS_CONFIG_KEY, false, 'boolean');
const enableServerPluginsAutoUpdate = !!getConfigValue('enableServerPluginsAutoUpdate', true, 'boolean');

/**
 * Map of loaded plugins.
 * @type {Map<string, any>}
 */
const loadedPlugins = new Map();

export function getLoadedServerPluginIds() {
    return [...loadedPlugins.keys()];
}

export function getLoadedServerPlugins() {
    return [...loadedPlugins.entries()].map(([id, record]) => ({
        id,
        directoryPath: record.directoryPath,
    }));
}

function isReservedPluginEntry(file) {
    return RESERVED_PLUGIN_ENTRIES.has(file);
}

/**
 * Determine if a file is a CommonJS module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is a CommonJS module
 */
const isCommonJS = (file) => path.extname(file) === '.js' || path.extname(file) === '.cjs';

/**
 * Determine if a file is an ECMAScript module.
 * @param {string} file Path to file
 * @returns {boolean} True if file is an ECMAScript module
 */
const isESModule = (file) => path.extname(file) === '.mjs';

/**
 * Load and initialize server plugins from a directory if they are enabled.
 * @param {import('express').Express} app Express app
 * @param {string} pluginsPath Path to plugins directory
 * @returns {Promise<Function>} Promise that resolves when all plugins are loaded. Resolves to a "cleanup" function to
 * be called before the server shuts down.
 */
export async function loadPlugins(app, pluginsPath) {
    try {
        const exitHooks = [];
        const emptyFn = () => { };

        // Server plugins are disabled.
        if (!enableServerPlugins) {
            warnAboutDisabledServerPlugins(pluginsPath);
            return emptyFn;
        }

        // Plugins directory does not exist.
        if (!fs.existsSync(pluginsPath)) {
            return emptyFn;
        }

        const files = fs.readdirSync(pluginsPath).filter(file => !isReservedPluginEntry(file));

        // No plugins to load.
        if (files.length === 0) {
            return emptyFn;
        }

        await updatePlugins(pluginsPath);

        for (const file of files) {
            const pluginFilePath = path.join(pluginsPath, file);

            if (fs.statSync(pluginFilePath).isDirectory()) {
                await loadFromDirectory(app, pluginFilePath, exitHooks);
                continue;
            }

            // Not a JavaScript file.
            if (!isCommonJS(file) && !isESModule(file)) {
                continue;
            }

            await loadFromFile(app, pluginFilePath, exitHooks, path.dirname(pluginFilePath));
        }

        if (loadedPlugins.size > 0) {
            console.log(`${loadedPlugins.size} server plugin(s) are currently loaded. Make sure you know exactly what they do, and only install plugins from trusted sources!`);
        }

        // Call all plugin "exit" functions at once and wait for them to finish
        return () => Promise.all(exitHooks.map(exitFn => exitFn()));
    } catch (error) {
        console.error('Plugin loading failed.', error);
        return () => { };
    }
}

async function loadFromDirectory(app, pluginDirectoryPath, exitHooks) {
    const files = fs.readdirSync(pluginDirectoryPath);

    // No plugins to load.
    if (files.length === 0) {
        return;
    }

    // Plugin is an npm package.
    const packageJsonFilePath = path.join(pluginDirectoryPath, 'package.json');
    if (fs.existsSync(packageJsonFilePath)) {
        if (await loadFromPackage(app, packageJsonFilePath, exitHooks)) {
            return;
        }
    }

    // Plugin is a module file.
    const fileTypes = ['index.js', 'index.cjs', 'index.mjs'];

    for (const fileType of fileTypes) {
        const filePath = path.join(pluginDirectoryPath, fileType);
        if (fs.existsSync(filePath)) {
            if (await loadFromFile(app, filePath, exitHooks, pluginDirectoryPath)) {
                return;
            }
        }
    }
}

/**
 * Loads and initializes a plugin from an npm package.
 * @param {import('express').Express} app Express app
 * @param {string} packageJsonPath Path to package.json file
 * @param {Array<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromPackage(app, packageJsonPath, exitHooks) {
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.main) {
            const pluginFilePath = path.join(path.dirname(packageJsonPath), packageJson.main);
            return await loadFromFile(app, pluginFilePath, exitHooks, path.dirname(packageJsonPath));
        }
    } catch (error) {
        console.error(`Failed to load plugin from ${packageJsonPath}: ${error}`);
    }
    return false;
}

/**
 * Loads and initializes a plugin from a file.
 * @param {import('express').Express} app Express app
 * @param {string} pluginFilePath Path to plugin directory
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @param {string} pluginDirectoryPath Path to the plugin directory
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was loaded successfully
 */
async function loadFromFile(app, pluginFilePath, exitHooks, pluginDirectoryPath = path.dirname(pluginFilePath)) {
    try {
        const fileUrl = url.pathToFileURL(pluginFilePath).toString();
        const plugin = await import(fileUrl);
        console.log(`Initializing plugin from ${pluginFilePath}`);
        return await initPlugin(app, plugin, exitHooks, pluginDirectoryPath);
    } catch (error) {
        console.error(`Failed to load plugin from ${pluginFilePath}: ${error}`);
        logMissingDependencyHint(error, pluginDirectoryPath);
        return false;
    }
}

/**
 * Warn when server plugins appear to be configured with a common typo or are installed but disabled.
 * @param {string} pluginsPath Path to plugins directory
 */
function warnAboutDisabledServerPlugins(pluginsPath) {
    const config = getConfig();
    const mistakenConfigKey = COMMON_SERVER_PLUGIN_CONFIG_MISTAKES.find(key => Object.prototype.hasOwnProperty.call(config, key));

    if (mistakenConfigKey) {
        console.warn(color.yellow(`Config key '${mistakenConfigKey}' is ignored. Did you mean '${SERVER_PLUGINS_CONFIG_KEY}' (plural and camelCase)?`));
    }

    if (hasPluginCandidates(pluginsPath)) {
        console.warn(color.yellow(`Server plugins are installed in ${pluginsPath}, but ${SERVER_PLUGINS_CONFIG_KEY} is false. Set ${SERVER_PLUGINS_CONFIG_KEY}: true in config.yaml to load them.`));
    }
}

/**
 * Check whether a plugins directory contains loadable plugin candidates.
 * @param {string} pluginsPath Path to plugins directory
 * @returns {boolean} True if the directory contains plugin candidates
 */
function hasPluginCandidates(pluginsPath) {
    try {
        if (!fs.existsSync(pluginsPath)) {
            return false;
        }

        return fs.readdirSync(pluginsPath)
            .filter(file => !file.startsWith('.'))
            .some(file => {
                try {
                    const pluginFilePath = path.join(pluginsPath, file);
                    const stat = fs.statSync(pluginFilePath);
                    return stat.isDirectory() || (stat.isFile() && (isCommonJS(file) || isESModule(file)));
                } catch {
                    return false;
                }
            });
    } catch {
        return false;
    }
}

/**
 * Log an actionable install hint when a server plugin fails because a package dependency is missing.
 * @param {unknown} error Import error
 * @param {string} pluginDirectoryPath Path to the plugin directory
 */
function logMissingDependencyHint(error, pluginDirectoryPath) {
    const missingDependency = getMissingDependencyName(error);

    if (!missingDependency) {
        return;
    }

    console.error(color.yellow(`Server plugin dependency '${missingDependency}' was not found.`));
    console.error(color.yellow(`Install the plugin's dependencies, then restart: cd "${pluginDirectoryPath}" && npm install`));
    console.error(color.yellow('If you use Bun, run bun install in the same plugin directory instead. Stop SillyBunny first if your package manager reports that node_modules is busy.'));
}

/**
 * Extract a missing package specifier from Node/Bun module resolution errors.
 * @param {unknown} error Import error
 * @returns {string|null} Missing dependency package name, if detected
 */
function getMissingDependencyName(error) {
    const message = String(error?.message ?? error);
    const match = message.match(/Cannot find package ['"]([^'"]+)['"]/) ||
        message.match(/Cannot find module ['"]([^'"]+)['"]/) ||
        message.match(/Could not resolve ['"]([^'"]+)['"]/) ||
        message.match(/Module not found.*['"]([^'"]+)['"]/);

    if (!match) {
        return null;
    }

    const specifier = match[1];
    if (
        specifier.startsWith('.')
        || specifier.startsWith('/')
        || specifier.startsWith('node:')
        || specifier.startsWith('file:')
        || path.isAbsolute(specifier)
        || /^[a-zA-Z]:[\\/]/.test(specifier)
    ) {
        return null;
    }

    return specifier;
}

/**
 * Check whether a plugin ID is valid (only lowercase alphanumeric, hyphens, and underscores).
 * @param {string} id The plugin ID to check
 * @returns {boolean} True if the plugin ID is valid.
 */
function isValidPluginID(id) {
    return /^[a-z0-9_-]+$/.test(id);
}

/**
 * Initializes a plugin module.
 * @param {import('express').Express} app Express app
 * @param {any} plugin Plugin module
 * @param {Array.<Function>} exitHooks Array of functions to be run on plugin exit. Will be pushed to if the plugin has
 * an "exit" function.
 * @returns {Promise<boolean>} Promise that resolves to true if plugin was initialized successfully
 */
async function initPlugin(app, plugin, exitHooks, pluginDirectoryPath) {
    const info = plugin.info || plugin.default?.info;
    if (typeof info !== 'object') {
        console.error('Failed to load plugin module; plugin info not found');
        return false;
    }

    // We don't currently use "name" or "description" but it would be nice to have a UI for listing server plugins, so
    // require them now just to be safe
    for (const field of ['id', 'name', 'description']) {
        if (typeof info[field] !== 'string') {
            console.error(`Failed to load plugin module; plugin info missing field '${field}'`);
            return false;
        }
    }

    const init = plugin.init || plugin.default?.init;
    if (typeof init !== 'function') {
        console.error('Failed to load plugin module; no init function');
        return false;
    }

    const { id } = info;

    if (!isValidPluginID(id)) {
        console.error(`Failed to load plugin module; invalid plugin ID '${id}'`);
        return false;
    }

    if (loadedPlugins.has(id)) {
        console.error(`Failed to load plugin module; plugin ID '${id}' is already in use`);
        return false;
    }

    // Allow the plugin to register API routes under /api/plugins/[plugin ID] via a router
    const router = express.Router();

    await init(router);

    loadedPlugins.set(id, {
        plugin,
        directoryPath: fs.realpathSync(pluginDirectoryPath),
    });

    // Add API routes to the app if the plugin registered any
    if (router.stack.length > 0) {
        app.use(`/api/plugins/${id}`, router);
    }

    const exit = plugin.exit || plugin.default?.exit;
    if (typeof exit === 'function') {
        exitHooks.push(exit);
    }

    return true;
}

/**
 * Automatically update all git plugins in the ./plugins directory
 * @param {string} pluginsPath Path to plugins directory
 */
async function updatePlugins(pluginsPath) {
    if (!enableServerPluginsAutoUpdate) {
        return;
    }

    const directories = fs.readdirSync(pluginsPath)
        .filter(file => !isReservedPluginEntry(file))
        .filter(file => fs.statSync(path.join(pluginsPath, file)).isDirectory());

    if (directories.length === 0) {
        return;
    }

    console.log(color.blue('Auto-updating server plugins... Set'), color.yellow('enableServerPluginsAutoUpdate: false'), color.blue('in config.yaml to disable this feature.'));

    if (!commandExistsSync('git')) {
        console.error(color.red('Git is not installed. Please install Git to enable auto-updating of server plugins.'));
        return;
    }

    let pluginsToUpdate = 0;

    for (const directory of directories) {
        try {
            const pluginPath = path.join(pluginsPath, directory);

            if (fs.existsSync(path.join(pluginPath, SERVER_PLUGIN_RELEASE_MARKER))) {
                console.log(`Skipping mutable auto-update for release-pinned plugin ${color.green(directory)}.`);
                continue;
            }

            const pluginRepo = git(pluginPath);

            const isRepo = await pluginRepo.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
            if (!isRepo) {
                continue;
            }

            await pluginRepo.fetch();
            const commitHash = await pluginRepo.revparse(['HEAD']);
            const trackingBranch = await pluginRepo.revparse(['--abbrev-ref', '@{u}']);
            const log = await pluginRepo.log({
                from: commitHash,
                to: trackingBranch,
            });

            if (log.total === 0) {
                continue;
            }

            pluginsToUpdate++;
            await pluginRepo.pull();
            const latestCommit = await pluginRepo.revparse(['HEAD']);
            console.log(`Plugin ${color.green(directory)} updated to commit ${color.cyan(latestCommit)}`);
        } catch (error) {
            console.error(color.red(`Failed to update plugin ${directory}: ${error.message}`));
        }
    }

    if (pluginsToUpdate === 0) {
        console.log('All plugins are up to date.');
    }
}
