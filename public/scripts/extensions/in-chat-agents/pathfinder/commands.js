import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

import { isPathfinderSubmoduleEnabled } from '../agent-store.js';
import { getTree, findNodeById } from './tree-store.js';
import { createEntry } from './entry-manager.js';
import { getActiveTunnelVisionBooks, getWritableBooks } from './pathfinder-tool-bridge.js';

const registeredCommands = [];

function findNodesByName(tree, lowerQuery, matches = []) {
    if (!tree) return matches;
    if (String(tree.name || '').toLowerCase().includes(lowerQuery)) {
        matches.push(tree);
    }
    for (const child of tree.children || []) {
        findNodesByName(child, lowerQuery, matches);
    }
    return matches;
}

function buildCommand(props) {
    return SlashCommand.fromProps({
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: props.argumentDescription,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        ...props,
    });
}

export function removeCommands() {
    for (const command of registeredCommands.splice(0)) {
        for (const name of [command.name, ...(command.aliases || [])]) {
            if (SlashCommandParser.commands?.[name] === command) {
                delete SlashCommandParser.commands[name];
            }
        }
    }
}

export function initCommands(registerSlashCommand) {
    removeCommands();

    const registerCommand = (command) => {
        if (typeof SlashCommandParser?.addCommandObject === 'function') {
            SlashCommandParser.addCommandObject(command);
            registeredCommands.push(command);
            return;
        }

        if (typeof registerSlashCommand === 'function') {
            registerSlashCommand(command.name, command.callback, command.aliases, command.helpString);
            registeredCommands.push(command);
        }
    };

    registerCommand(buildCommand({
        name: 'pf-remember',
        helpString: 'Force Pathfinder to save something to memory.',
        argumentDescription: 'Content to remember',
        callback: async (_, content) => {
            if (!isPathfinderSubmoduleEnabled()) {
                return 'Pathfinder is disabled.';
            }
            content = String(content || '').trim();
            if (!content) return 'Nothing to remember.';
            const books = getWritableBooks();
            if (books.length === 0) return 'No writable Pathfinder-enabled lorebooks.';
            const bookName = books[0];
            try {
                await createEntry(bookName, content.slice(0, 50), content);
                return `Remembered in "${bookName}".`;
            } catch (err) {
                return `Error: ${err.message}`;
            }
        },
    }));

    registerCommand(buildCommand({
        name: 'pf-search',
        helpString: 'Force Pathfinder to search the waypoint map.',
        argumentDescription: 'Search query',
        callback: async (_, query) => {
            if (!isPathfinderSubmoduleEnabled()) {
                return 'Pathfinder is disabled.';
            }
            query = String(query || '').trim();
            if (!query) return 'No search query.';
            const q = query.toLowerCase();
            const results = [];
            for (const bookName of getActiveTunnelVisionBooks()) {
                const tree = getTree(bookName);
                if (!tree) continue;
                const exact = findNodeById(tree, query);
                const matches = exact ? [exact] : findNodesByName(tree, q);
                for (const node of matches) {
                    results.push(`${bookName}: ${node.name} (${(node.entries || []).length} entries)${node.id ? ` [id: ${node.id}]` : ''}`);
                }
            }
            return results.length > 0 ? results.join('\n') : 'No waypoints found matching query.';
        },
    }));
}
