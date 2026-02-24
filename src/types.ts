import {AutocompleteInteraction, CommandInteraction, ComponentInteraction, CreateApplicationCommandOptions} from "oceanic.js";
import {BunSQLiteDatabase} from "drizzle-orm/bun-sqlite";

export type CommandExport = {
    CommandInfo: CreateApplicationCommandOptions,
    execute: (interaction: CommandInteraction, database: BunSQLiteDatabase) => Promise<void>,
    handleAutocomplete?: (interaction: AutocompleteInteraction, database: BunSQLiteDatabase) => Promise<void>
}
