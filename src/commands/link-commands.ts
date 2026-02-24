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
    const destinationChannel = interaction.data.options.getChannel("destination") ?? voiceChannel;

    if (!interaction.guild || !voiceChannel || !destinationChannel) {
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
            const role = interaction.data.options.getRole("role");
            if (!role) {
                await interaction.createMessage({
                    content: "An error occured! missing role, how?",
                    flags: MessageFlags.EPHEMERAL
                });
                return;
            }

            const previousLinks = await database.select().from(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));

            if (previousLinks.length > 0) {
                await database.update(notificationChannelLinks).set({
                    roleId: role.id,
                    notifChannelId: destinationChannel.id,
                }).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
                await interaction.createMessage({
                    content: `Updated link <#${voiceChannel.id}> to destination <#${destinationChannel.id}> with role <@&${role.id}>`,
                    flags: MessageFlags.EPHEMERAL
                });
            } else {
                await database.insert(notificationChannelLinks).values({
                    voiceChannelId: voiceChannel.id,
                    guildId: interaction.guild.id,
                    notifChannelId: destinationChannel.id,
                    roleId: role.id
                });
                await interaction.createMessage({
                    content: `Created link <#${voiceChannel.id}> to destination <#${destinationChannel.id}> with role <@&${role.id}>`,
                    flags: MessageFlags.EPHEMERAL
                });
            }
            break;
        }
        case "scribe-channel": {
            const previousLinks = await database.select().from(scribeLinks).where(eq(scribeLinks.voiceChannelId, voiceChannel.id));

            if (previousLinks.length > 0) {
                await database.update(scribeLinks).set({
                    scribeChannelId: destinationChannel.id,
                }).where(eq(scribeLinks.voiceChannelId, voiceChannel.id));
                await interaction.createMessage({
                    content: `Updated scribe link <#${voiceChannel.id}> to destination <#${destinationChannel.id}>. Don't forget to create a webhook.`,
                    flags: MessageFlags.EPHEMERAL
                });
            } else {
                await database.insert(scribeLinks).values({
                    voiceChannelId: voiceChannel.id,
                    guildId: interaction.guild.id,
                    scribeChannelId: destinationChannel.id
                });
                await interaction.createMessage({
                    content: `Created scribe link <#${voiceChannel.id}> to destination <#${destinationChannel.id}>. Don't forget to create a webhook.`,
                    flags: MessageFlags.EPHEMERAL
                });
            }
            break;
        }
    }
}
const command: CommandExport = {
    execute,
    CommandInfo: {
        name: "link",
        description: "Link command",
        type: ApplicationCommandTypes.CHAT_INPUT,
        contexts: [InteractionContextTypes.GUILD],
        defaultMemberPermissions: "8",
        options: [
            {
                type: ApplicationCommandOptionTypes.SUB_COMMAND,
                name: "notifications",
                description: "link the notification channel where call pings happen.",
                options: [
                    {
                        type: ApplicationCommandOptionTypes.CHANNEL,
                        name: "voice-channel",
                        description: "Voice channel to watch",
                        required: true,
                        channelTypes: [ChannelTypes.GUILD_VOICE],
                    },
                    {
                        type: ApplicationCommandOptionTypes.ROLE,
                        name: "role",
                        description: "the role to ping",
                        required: true
                    },
                    {
                        type: ApplicationCommandOptionTypes.CHANNEL,
                        name: "destination",
                        description: "Destination of role pings",
                        channelTypes: [ChannelTypes.GUILD_TEXT, ChannelTypes.GUILD_VOICE],
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
                        description: "Voice channel to watch",
                        required: true,
                        channelTypes: [ChannelTypes.GUILD_VOICE],
                    },
                    {
                        type: ApplicationCommandOptionTypes.CHANNEL,
                        name: "destination",
                        description: "Destination of scribing",
                        channelTypes: [ChannelTypes.GUILD_TEXT, ChannelTypes.GUILD_VOICE],
                    }
                ],
            }
        ]
    }
}

export default command