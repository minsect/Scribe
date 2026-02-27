import type {CommandExport} from "../types.ts";
import { eq, and } from 'drizzle-orm';
import {scribeConsent} from '../db/schema.ts';

import {
    ApplicationCommandOptionTypes,
    ApplicationCommandTypes, AutocompleteInteraction, ButtonStyles, CommandInteraction,
    InteractionContextTypes,
    MessageFlags
} from "oceanic.js";
import { LibSQLDatabase } from "drizzle-orm/libsql";

async function execute(interaction: CommandInteraction, database: LibSQLDatabase): Promise<void> {
    if (!interaction.member || interaction.member == null || !interaction.guildID) {
        await interaction.createMessage({
            content: "We cannot trace you. Please try this command in a guild.", 
            flags: MessageFlags.EPHEMERAL
        })
        return;
    }
    const voiceChannelId = interaction.data.options.getString("voice-channel");
    if (!voiceChannelId) {
        await interaction.createMessage({
            content: "You are not opted into this channel!", 
            flags: MessageFlags.EPHEMERAL
        });
        return; 
    }
    const scribeChannelLinks = await database.select().from(scribeConsent).where(and(
        eq(scribeConsent.userId, interaction.member.id),
        eq(scribeConsent.voiceChannelId, voiceChannelId)
    ));
    if (scribeChannelLinks.length == 0) {
        await interaction.createMessage({
            content: "You are not opted into this channel!", 
            flags: MessageFlags.EPHEMERAL
        });
        return;
    }
    await database.delete(scribeConsent).where(and(
        eq(scribeConsent.userId, interaction.member.id),
        eq(scribeConsent.voiceChannelId, voiceChannelId)
    ));
    await interaction.createMessage({
        content: `Successfully opted out of scribing in <#${voiceChannelId}>!`,
        flags: MessageFlags.EPHEMERAL
    })

}

async function handleAutocomplete(interaction: AutocompleteInteraction, database: LibSQLDatabase) {
    const focused = interaction.data.options.getFocused();
    if (focused && focused.name === "voice-channel") {
        const scribeChannelLinks = await database.select().from(scribeConsent).where(and(
            eq(scribeConsent.userId, interaction.member!.id),
            eq(scribeConsent.guildId, interaction.guildID!)
        ));

        const choices = scribeChannelLinks
            .map(link => {
                if (!interaction.guild) {
                    return {name: `<#${link.voiceChannelId}>`, value: link.voiceChannelId}
                }
                const channel = interaction.guild?.channels.find((channel) => channel.id == link.voiceChannelId)
                if (channel) {
                    return {name: channel.name, value: link.voiceChannelId}
                } else {
                    return {name: `<#${link.voiceChannelId}>`, value: link.voiceChannelId}
                }
            })
            .slice(0, 25);

        await interaction.result(choices);
    }
}

const command: CommandExport = {
    execute,
    handleAutocomplete,
    CommandInfo: {
        name: "unconsent",
        description: "Unconsent from being scribed",
        type: ApplicationCommandTypes.CHAT_INPUT,
        contexts: [InteractionContextTypes.GUILD],
        options: [
            {
                name: "voice-channel",
                description: "The voice channel to opt out from",
                type: ApplicationCommandOptionTypes.STRING,
                autocomplete: true,
                required: true
            }
        ]
    }
}

export default command;
