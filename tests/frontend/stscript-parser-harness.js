/**
 * Installs window.stscriptHarness in the page. Playwright serialises the function source,
 * so nothing in here may reference module scope.
 */
export async function installStscriptHarness() {
    const [
        { SlashCommandParser, PARSER_FLAG },
        { SlashCommandParserError },
        { SlashCommandClosure },
        { SlashCommand },
        { SlashCommandBreak },
        { SlashCommandBreakPoint },
        { SlashCommandDebugController },
        { SlashCommandAbortController },
        { SlashCommandArgument, ARGUMENT_TYPE },
        { setSlashCommandParserSettingsGetter },
    ] = await Promise.all([
        import('/scripts/slash-commands/SlashCommandParser.js'),
        import('/scripts/slash-commands/SlashCommandParserError.js'),
        import('/scripts/slash-commands/SlashCommandClosure.js'),
        import('/scripts/slash-commands/SlashCommand.js'),
        import('/scripts/slash-commands/SlashCommandBreak.js'),
        import('/scripts/slash-commands/SlashCommandBreakPoint.js'),
        import('/scripts/slash-commands/SlashCommandDebugController.js'),
        import('/scripts/slash-commands/SlashCommandAbortController.js'),
        import('/scripts/slash-commands/SlashCommandArgument.js'),
        import('/scripts/slash-commands/SlashCommandParserConfig.js'),
    ]);

    const registerCommand = (name, props = {}) => {
        if (SlashCommandParser.commands[name]) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            callback: () => '',
            unnamedArgumentList: [SlashCommandArgument.fromProps({ description: name, typeList: [ARGUMENT_TYPE.STRING] })],
            ...props,
        }));
    };
    registerCommand('stp-plain');
    registerCommand('stp-raw', { rawQuotes: true });
    registerCommand('stp-split', { splitUnnamedArgument: true });
    registerCommand('stp-split1', { splitUnnamedArgument: true, splitUnnamedArgumentCount: 1 });
    registerCommand('stp-split2', { splitUnnamedArgument: true, splitUnnamedArgumentCount: 2 });
    registerCommand('stp-aliased', { aliases: ['stp-aka'] });
    // The Quick Reply extension owns /import and can be disabled.
    registerCommand('import', { splitUnnamedArgument: true });

    /** Fixtures name flags, and the parser keys them by number. A flag that a fixture leaves out stays undefined, so the parser uses the configured flag. */
    const toFlagMap = named => named ? Object.fromEntries(Object.entries(named).map(([name, state]) => [PARSER_FLAG[name], state])) : null;
    const flagNames = flags => Object.entries(PARSER_FLAG).filter(([, key]) => flags?.[key]).map(([name]) => name);

    let settings = { experimentalMacroEngine: false, flags: {} };
    setSlashCommandParserSettingsGetter(() => settings);

    const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, field]) => field !== undefined));

    const serialize = (parser, root, positions) => {
        const uuids = new Map();
        const stable = text => text.replace(/_PARSER_(PIPE|VAR)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (match, kind) => {
            if (!uuids.has(match)) uuids.set(match, uuids.size + 1);
            return `_PARSER_${kind}_${uuids.get(match)}`;
        });
        const value = raw => {
            if (raw instanceof SlashCommandClosure) return { closure: closure(raw, false) };
            if (raw === undefined) return null;
            return typeof raw === 'string' ? stable(raw) : { unexpected: typeof raw };
        };
        const named = assignment => defined({
            name: assignment.name,
            value: value(assignment.value),
            ...(positions ? { start: assignment.start, end: assignment.end } : {}),
        });
        const unnamed = assignment => positions
            ? defined({ value: value(assignment.value), start: assignment.start, end: assignment.end })
            : value(assignment.value);
        const executor = item => {
            const out = { name: item.name };
            if (item instanceof SlashCommandBreakPoint) out.kind = 'breakpoint';
            else if (item instanceof SlashCommandBreak) out.kind = 'break';
            const commandName = item.command?.name ?? null;
            if (commandName !== item.name) out.command = commandName;
            if (item.namedArgumentList.length) out.named = item.namedArgumentList.map(named);
            if (item.unnamedArgumentList.length) out.unnamed = item.unnamedArgumentList.map(unnamed);
            if (item.injectPipe !== true) out.injectPipe = item.injectPipe ?? null;
            const enabled = flagNames(item.parserFlags);
            if (enabled.length) out.flags = enabled;
            if (positions) {
                out.pos = defined({
                    start: item.start,
                    end: item.end,
                    startNamedArgs: item.startNamedArgs,
                    endNamedArgs: item.endNamedArgs,
                    startUnnamedArgs: item.startUnnamedArgs,
                    endUnnamedArgs: item.endUnnamedArgs,
                });
            }
            return out;
        };
        const closure = (item, isRoot) => {
            const out = {};
            if (!isRoot) out.rawText = item.rawText;
            if (item.executeNow) out.executeNow = true;
            if (item.argumentList.length) out.args = item.argumentList.map(named);
            if (item.scope.variableNames.length) out.variables = item.scope.variableNames.map(stable);
            out.executors = item.executorList.map(executor);
            return out;
        };
        const result = { tree: closure(root, true) };
        if (positions) {
            result.index = {
                commands: parser.commandIndex.map(item => defined({ name: item.name, start: item.start, end: item.end })),
                closures: parser.closureIndex.map(item => defined({ start: item.start, end: item.end })),
                macros: parser.macroIndex.map(item => defined({ name: item.name, start: item.start, end: item.end })),
                scopes: parser.scopeIndex.map(scope => scope.allVariableNames.map(stable)),
            };
        }
        return result;
    };

    const describeError = (error, script) => {
        if (!(error instanceof SlashCommandParserError)) {
            return { error: { type: error?.constructor?.name ?? typeof error, message: String(error?.message ?? error) } };
        }
        // The line, column and hint getters read the text and throw on an error that carries none.
        const hasText = error.text === script;
        const position = hasText ? { line: error.line, column: error.column, hint: error.hint } : {};
        return { error: { type: 'SlashCommandParserError', message: error.message, index: error.index ?? null, hasText, ...position } };
    };

    const parseWith = (parser, item) => {
        settings = { experimentalMacroEngine: Boolean(item.experimentalMacroEngine), flags: toFlagMap(item.configuredFlags) ?? {} };
        return parser.parse(
            item.script,
            item.verify ?? true,
            toFlagMap(item.flags),
            null,
            item.debug ? new SlashCommandDebugController() : null,
        );
    };

    const run = (item, parser = new SlashCommandParser()) => {
        try {
            return serialize(parser, parseWith(parser, item), Boolean(item.positions));
        } catch (error) {
            return describeError(error, item.script);
        }
    };

    const runOnOneParser = items => {
        const parser = new SlashCommandParser();
        return items.map(item => run(item, parser));
    };

    const outcome = item => {
        try {
            parseWith(new SlashCommandParser(), item);
            return 'tree';
        } catch (error) {
            const indexInside = Number.isInteger(error?.index) && error.index >= 0 && error.index <= item.script.length;
            if (error instanceof SlashCommandParserError && indexInside && error.text === item.script) return 'error';
            return { type: error?.constructor?.name ?? typeof error, message: String(error?.message ?? error), index: error?.index ?? null };
        }
    };

    /**
     * Reduces each parse to 'tree', 'error' (a well-formed parser error) or a description of what went wrong.
     * The parser calls console.warn for some rejected scripts. With Playwright attached, that call costs more
     * than the parse, so console.warn stays silent while the batch runs.
     */
    const outcomes = items => {
        const warn = console.warn;
        console.warn = () => {};
        try {
            return items.map(outcome);
        } finally {
            console.warn = warn;
        }
    };

    const controllers = () => {
        const abortController = new SlashCommandAbortController();
        const debugController = new SlashCommandDebugController();
        const root = new SlashCommandParser().parse('/stp-plain {: /stp-plain {: /stp-plain deep :} :}', true, null, abortController, debugController);
        const outer = root.executorList[0].unnamedArgumentList[0].value;
        const inner = outer.executorList[0].unnamedArgumentList[0].value;
        return [root, outer, inner].map(item => ({
            abort: item.abortController === abortController,
            debug: item.debugController === debugController,
        }));
    };

    window.stscriptHarness = { run, runOnOneParser, outcomes, controllers };
}
