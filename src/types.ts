import type {AutocompleteInteraction, CommandInteraction, CreateApplicationCommandOptions} from "oceanic.js";
import { LibSQLDatabase } from "drizzle-orm/libsql";

export type CommandExport = {
    CommandInfo: CreateApplicationCommandOptions,
    execute: (interaction: CommandInteraction, database: LibSQLDatabase) => Promise<void>,
    handleAutocomplete?: (interaction: AutocompleteInteraction, database: LibSQLDatabase) => Promise<void>
}
