import type {CommandExport} from "../types.ts";
import { eq } from 'drizzle-orm';
import { notificationChannelLinks } from '../db/schema.ts';

import {
    ApplicationCommandOptionTypes,
    ApplicationCommandTypes,
    ChannelTypes, CommandInteraction,
    InteractionContextTypes, MessageFlags
} from "oceanic.js";
import { LibSQLDatabase } from "drizzle-orm/libsql";

async function execute(interaction: CommandInteraction, database: LibSQLDatabase): Promise<void> {
    const voiceChannel = interaction.data.options.getChannel("voice-channel");
    if (!interaction.guild || !voiceChannel || !interaction.member) {
        await interaction.createMessage({content: `An error occured! missing critical information.`, flags: MessageFlags.EPHEMERAL});
        return;
    }
    const previousLinks = await database.select().from(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
    if (previousLinks.length > 0 && previousLinks[0].roleId) {
        const role = interaction.guild.roles.find(role => role.id == previousLinks[0].roleId);
        if (role) {
            if (interaction.member.roles.find(r => r == role.id)) {
                // the member has this role already, remove it
                try {
                    await interaction.member.removeRole(role.id, "opt command used");
                    await interaction.createMessage({content: `You will no longer receive notifications for <#${voiceChannel.id}>.`, flags: MessageFlags.EPHEMERAL});
                } catch (err) {
                    console.log(err);
                    await interaction.createMessage({content: `There was an issue removing your role. Maybe check permissions?`});
                }
            } else {
                // add the role to them
                try {
                    await interaction.member.addRole(role.id, "opt command used");
                    await interaction.createMessage({content: `Successfully opted in to receive notifications for <#${voiceChannel.id}>.`, flags: MessageFlags.EPHEMERAL});
                } catch (err) {
                    console.log(err);
                    await interaction.createMessage({content: `There was an issue adding your role. Maybe check permissions?`});
                }
            }

        } else {
            await interaction.createMessage({content: `No role found for <#${voiceChannel.id}>. please contact admins!`});
        }
    } else {
        await interaction.createMessage({content: `<#${voiceChannel.id}> is not registered with the bot.`, flags: MessageFlags.EPHEMERAL});
    }
}
const command: CommandExport = {
    execute,
    CommandInfo: {
        name: "opt",
        description: "Opt into / out of the role for this voice channel.",
        type: ApplicationCommandTypes.CHAT_INPUT,
        contexts: [InteractionContextTypes.GUILD],
        options: [
            {
                type: ApplicationCommandOptionTypes.CHANNEL,
                name: "voice-channel",
                description: "Voice channel to opt into",
                required: true,
                channelTypes: [ChannelTypes.GUILD_VOICE],
            }
        ]
    }
}

export default command