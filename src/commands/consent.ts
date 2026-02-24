import {CommandExport} from "../types";
import { eq, and } from 'drizzle-orm';
import {notificationChannelLinks, scribeConsent, scribeLinks} from '../db/schema';

import {
    ApplicationCommandTypes, CommandInteraction,
    InteractionContextTypes,
    MessageFlags
} from "oceanic.js";
import {BunSQLiteDatabase} from "drizzle-orm/bun-sqlite";

async function execute(interaction: CommandInteraction, database: BunSQLiteDatabase): Promise<void> {
    if (!interaction.member || interaction.member == null || interaction.guildID == null) {
        await interaction.createMessage({
            content: "We cannot trace you. Please try this command in a guild.", 
            flags: MessageFlags.EPHEMERAL
        })
        return;
    }
    const voiceChannelId = interaction.member.voiceState?.channelID
    if (!voiceChannelId) {
        await interaction.createMessage({
            content: "This command only works when you are in a voice chat the bot can see.", 
            flags: MessageFlags.EPHEMERAL
        })
        return;
    }
    const scribeChannelLink = await database.select().from(scribeLinks).where(eq(scribeLinks.voiceChannelId, voiceChannelId))
    if (scribeChannelLink.length == 0) {
        await interaction.createMessage({
            content: "This voice chat isn't signed up for scribing!", 
            flags: MessageFlags.EPHEMERAL
        });
        return;
    }
    const previousLinks = await database.select().from(scribeConsent).where(and(
        eq(scribeConsent.voiceChannelId, voiceChannelId),
        eq(scribeConsent.userId, interaction.member.id)
    ));
    if (previousLinks.length == 0) {
        await database.insert(scribeConsent).values({
            voiceChannelId: voiceChannelId,
            guildId: interaction.guildID,
            userId: interaction.member.id
        })
        await interaction.createMessage({
            content: `Your words spoken in <#${voiceChannelId}> shall be written to <#${scribeChannelLink[0].scribeChannelId}>.\nYou may have to rejoin for changes to apply.`,
            flags: MessageFlags.EPHEMERAL
        })
    } else {
        await interaction.createMessage({
            content: "You already consented to having your words scribed! use \`/scribe-opt-out\` if you wish to opt out.",
            flags: MessageFlags.EPHEMERAL
        })
    }
}
const command: CommandExport = {
    execute,
    CommandInfo: {
        name: "consent",
        description: "Consent to scribe writing down your words. Must be in voice chat to consent.",
        type: ApplicationCommandTypes.CHAT_INPUT,
        contexts: [InteractionContextTypes.GUILD]
    }
}

export default command