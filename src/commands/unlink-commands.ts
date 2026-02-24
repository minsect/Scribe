import {CommandExport} from "../types";
import { eq } from 'drizzle-orm';
import {notificationChannelLinks, scribeLinks} from '../db/schema';

import {
    ApplicationCommandOptionTypes,
    ApplicationCommandTypes,
    ChannelTypes, CommandInteraction,
    InteractionContextTypes, MessageFlags
} from "oceanic.js";
import {BunSQLiteDatabase} from "drizzle-orm/bun-sqlite";

async function execute(interaction: CommandInteraction, database: BunSQLiteDatabase): Promise<void> {
    const voiceChannel = interaction.data.options.getChannel("voice-channel");
    if (!interaction.guild || !voiceChannel) {
        await interaction.createMessage({content: `An error occured! missing critical information.`, flags: MessageFlags.EPHEMERAL});
        return;
    }
    const subCommand = interaction.data.options.getSubCommand();
    if (!subCommand) {
        await interaction.createMessage({content: `An error occured! how is there no subcommand?`, flags: MessageFlags.EPHEMERAL});
        return;
    } 
    switch (subCommand.join(" ")) {
        case "notifications": {
            const previousLinks = await database.select().from(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
            if (previousLinks.length > 0) {
                await database.delete(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
                await interaction.createMessage({
                    content: `Removed link <#${voiceChannel.id}>.`,
                    flags: MessageFlags.EPHEMERAL
                });
            } else {
                await interaction.createMessage({content: `No link found!`, flags: MessageFlags.EPHEMERAL});
            }
            break;
        }
        case "scribe-channel": {
            const previousLinks = await database.select().from(scribeLinks).where(eq(scribeLinks.voiceChannelId, voiceChannel.id));
            if (previousLinks.length > 0) {
                await database.delete(scribeLinks).where(eq(scribeLinks.voiceChannelId, voiceChannel.id));
                await interaction.createMessage({
                    content: `Removed scribe link <#${voiceChannel.id}>.`,
                    flags: MessageFlags.EPHEMERAL
                });
            } else {
                await interaction.createMessage({content: `No scribe link found!`, flags: MessageFlags.EPHEMERAL});
            }
            break;
        }
    }
}
const command: CommandExport = {
    execute,
    CommandInfo: {
        name: "unlink",
        description: "Unlink command",
        type: ApplicationCommandTypes.CHAT_INPUT,
        contexts: [InteractionContextTypes.GUILD],
        defaultMemberPermissions: "8",
        options: [
            {
                type: ApplicationCommandOptionTypes.SUB_COMMAND,
                name: "notifications",
                description: "link the notification channel where call pings happen. No channel de-sets it.",
                options: [
                    {
                        type: ApplicationCommandOptionTypes.CHANNEL,
                        name: "voice-channel",
                        description: "Voice channel to unlink",
                        required: true,
                        channelTypes: [ChannelTypes.GUILD_VOICE],
                    }
                ],
            },
            {
                type: ApplicationCommandOptionTypes.SUB_COMMAND,
                name: "scribe-channel",
                description: "Set the scribe channel where call transcriptions get sent. No channel de-sets it.",
                options: [
                    {
                        type: ApplicationCommandOptionTypes.CHANNEL,
                        name: "voice-channel",
                        description: "Voice channel to unlink",
                        required: true,
                        channelTypes: [ChannelTypes.GUILD_VOICE],
                    }
                ],
            }
        ]
    }
}

export default command