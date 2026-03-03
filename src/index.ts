import { Client, ChannelTypes, InteractionTypes, Member, StageChannel, VoiceChannel } from "oceanic.js";
import type { ExecuteWebhookOptions, Uncached } from "oceanic.js";
import { EndBehaviorType } from "@discordjs/voice";
import fs from "fs/promises";
import path from "path";
import type { CommandExport } from "./types.ts";
import { drizzle } from 'drizzle-orm/libsql';
import { notificationChannelLinks, scribeLinks, scribeConsent } from "./db/schema.ts";
import { eq, and } from "drizzle-orm";
import pkg from '@discordjs/opus';
const { OpusEncoder } = pkg;
import { spawn } from "child_process";
type VoiceConnection = Awaited<ReturnType<VoiceChannel["join"]>>;

process.loadEnvFile(".env")

const client = new Client({ auth: "Bot " + process.env.TOKEN });
const db = drizzle("file:" + process.env.DB_FILE_NAME!);

function prettyTime(ms: number) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const mDisplay = minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "";
    const sDisplay = seconds > 0 ? `${seconds} second${seconds === 1 ? "" : "s"}` : "";
    return [mDisplay, sDisplay].filter(Boolean).join(" and ") || "0 seconds";
}

const queue = new Map<string, { content?: ExecuteWebhookOptions, executing?: boolean }[]>()

setInterval(async () => {
    for (const [textChannelId, messages] of queue.entries()) {
        if (messages.length === 0) continue;

        const nextMessage = messages.find(msg => msg.content && !msg.executing);
        if (!nextMessage) continue;

        nextMessage.executing = true; // mark as in-progress

        const destinationChannel = client.getChannel(textChannelId);
        if (!destinationChannel ||
            !(destinationChannel.type === ChannelTypes.GUILD_TEXT || destinationChannel.type === ChannelTypes.GUILD_VOICE)) {
            nextMessage.executing = false;
            continue;
        }

        const webhooks = await destinationChannel.getWebhooks();
        if (webhooks.length === 0) {
            nextMessage.executing = false;
            continue;
        }

        try {
            await webhooks[0].execute(nextMessage.content!);
            const index = messages.indexOf(nextMessage);
            if (index !== -1) messages.splice(index, 1);
        } catch (e) {
            nextMessage.executing = false;
        }
    }
}, 300);

const commandsPath = path.join(import.meta.dirname, "commands")
const commands = new Map<string, CommandExport>()
for (const file of (await fs.readdir(commandsPath))) {
    if (file.endsWith(".ts")) {
        const info = (await import(path.join(commandsPath, file))).default
        commands.set(info.CommandInfo.name, info)
    }
}

const callStatuses: { [voiceChannelId: string]: { timeout?: ReturnType<typeof setTimeout>, joinTime: number } } = {}

function enqueuePlaceholder(textChannelId: string, uuid?: string) {
    if (!queue.has(textChannelId)) queue.set(textChannelId, []);

    const placeholder: { content?: ExecuteWebhookOptions, executing?: boolean } = {};

    queue.get(textChannelId)!.push(placeholder);
    return placeholder;
}
async function transcribe(audioBuffer: Buffer<ArrayBuffer>, textChannelId: string, userId: string) {
    console.log("new transcription requested...");

    const destinationChannel = client.getChannel(textChannelId);
    if (!destinationChannel || !(destinationChannel.type === ChannelTypes.GUILD_TEXT || destinationChannel.type === ChannelTypes.GUILD_VOICE)) return;

    const member = await destinationChannel.guild.getMember(userId);
    if (!member) return;

    const placeholder = enqueuePlaceholder(textChannelId);

    const ffmpeg = spawn("ffmpeg", [
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "-i", "pipe:0",
        "-v", "quiet",
        "-ac", "1",
        "-f", "wav",
        "-"
    ]);

    ffmpeg.stdin.write(audioBuffer);
    ffmpeg.stdin.end();

    const stdoutChunks: Buffer[] = [];
    ffmpeg.stdout.on('data', data => stdoutChunks.push(data));

    ffmpeg.on('exit', async () => {
        const audioBlob = new Blob([Buffer.concat(stdoutChunks)], { type: 'audio/wav' });
        const body = new FormData();
        body.set("temperature", "0.0");
        body.set("response_format", "json");
        body.set("temperature_inc", "0.2");
        body.set("file", audioBlob, "rec.wav");

        const response = await fetch("http://127.0.0.1:8080/inference", { method: "POST", body });
        if (!response.ok) return;

        const data = await response.json();
        if (!("text" in data) || data.text.trim() === "") return;

        // Update placeholder
        placeholder.content = {
            username: member.displayName,
            avatarURL: member.avatarURL(),
            content: data.text.trim()
        };
    });
}

async function speakHandler(userId: string, connection: VoiceConnection, textChannelId: string, voiceChannelId: string) {
    const scribeUsers = await db.select().from(scribeConsent).where(and(
        eq(scribeConsent.userId, userId),
        eq(scribeConsent.voiceChannelId, voiceChannelId)
    ));
    if (scribeUsers.length === 0) return;

    const encoder = new OpusEncoder(48000, 2);
    const audioStream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 100 } });

    const pcmChunks: Buffer[] = [];
    audioStream.on('data', chunk => {
        try { pcmChunks.push(encoder.decode(chunk)); } catch {}
    });

    audioStream.on('end', async function handler() {
        const fullPcm = Buffer.concat(pcmChunks);
        if (fullPcm.length < 30000) return;

        audioStream.off('end', handler);

        transcribe(fullPcm, textChannelId, userId);

    });
}

async function voiceChannelJoin(member: Member, channel: Uncached | VoiceChannel | StageChannel) {
    if (member.id === client.user.id) return;

    let voiceChannel: VoiceChannel | StageChannel;
    if (!("voiceMembers" in channel)) {
        const vc = client.getChannel(channel.id);
        if (vc && "voiceMembers" in vc) voiceChannel = vc;
        else return;
    } else voiceChannel = channel;

    const scribeLink = await db.select().from(scribeLinks).where(eq(scribeLinks.voiceChannelId, voiceChannel.id));
    if (scribeLink.length > 0) {
        const scribeUsers = await db.select().from(scribeConsent).where(and(
            eq(scribeConsent.userId, member.id),
            eq(scribeConsent.voiceChannelId, voiceChannel.id)
        ));
        if (scribeUsers.length > 0) {
            const vcConnection = await voiceChannel.join({ selfMute: true });
            vcConnection.receiver.speaking.on("start", (userId) => {
                if (userId === member.id) speakHandler(userId, vcConnection, scribeLink[0].scribeChannelId, voiceChannel.id);
            });
        }
    }

    if (voiceChannel.voiceMembers.filter(m => m.id !== client.user.id).length !== 1) return;

    const relatedLinks = await db.select().from(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
    if (relatedLinks.length > 0) {
        const destinationChannel = voiceChannel.guild.channels.find(ch => ch.id === relatedLinks[0].notifChannelId);
        if (destinationChannel && (destinationChannel.type === ChannelTypes.GUILD_VOICE || destinationChannel.type === ChannelTypes.GUILD_TEXT)) {
            const now = Date.now();
            const timer = setTimeout(async () => {
                const updatedChannel = client.getChannel(voiceChannel.id);
                if (updatedChannel && updatedChannel.type === ChannelTypes.GUILD_VOICE &&
                    updatedChannel.voiceMembers.filter(m => m.id !== client.user.id).length >= 1) {
                    await destinationChannel.createMessage({
                        content: `<@&${relatedLinks[0].roleId}> Call in <#${voiceChannel.id}> started by <@${member.id}>`,
                        allowedMentions: { everyone: false, roles: [relatedLinks[0].roleId], users: false }
                    });
                }
                if (callStatuses[voiceChannel.id]) delete callStatuses[voiceChannel.id].timeout;
            }, 5000);
            callStatuses[voiceChannel.id] = { timeout: timer, joinTime: now };
        }
    }
}

async function voiceChannelLeave(member: Member, channel: Uncached | VoiceChannel | StageChannel | null) {
    if (!channel || member.id === client.user.id) return;

    let voiceChannel: VoiceChannel | StageChannel;
    if (!("voiceMembers" in channel)) {
        const vc = client.getChannel(channel.id);
        if (vc && "voiceMembers" in vc) voiceChannel = vc;
        else return;
    } else voiceChannel = channel;

    if (voiceChannel.voiceMembers.filter(m => m.id !== client.user.id).length !== 0) return;

    const relatedLinks = await db.select().from(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
    if (voiceChannel.voiceMembers.has(client.user.id)) voiceChannel.leave();

    if (relatedLinks.length > 0 && callStatuses[voiceChannel.id]) {
        const callStatus = callStatuses[voiceChannel.id];
        if (callStatus.timeout) clearTimeout(callStatus.timeout);
        else {
            const destinationChannel = voiceChannel.guild.channels.find(ch => ch.id === relatedLinks[0].notifChannelId);
            if (destinationChannel && (destinationChannel.type === ChannelTypes.GUILD_TEXT || destinationChannel.type === ChannelTypes.GUILD_VOICE)) {
                await destinationChannel.createMessage({
                    content: `Call in <#${voiceChannel.id}> ended: lasted for ${prettyTime(Date.now() - callStatus.joinTime)}`,
                    allowedMentions: { everyone: false, roles: false, users: false }
                });
            }
        }
        delete callStatuses[voiceChannel.id];
    }
}

client.on("voiceChannelJoin", voiceChannelJoin);
client.on("voiceChannelLeave", voiceChannelLeave);
client.on("voiceChannelSwitch", async (member, voiceChannel, oldVoiceChannel) => {
    await voiceChannelLeave(member, oldVoiceChannel);
    await voiceChannelJoin(member, voiceChannel);
});

client.on("error", console.error);

client.on("ready", async () => {
    console.log("Ready as", client.user.tag);
    await client.application.bulkEditGlobalCommands(Array.from(commands.values(), cmd => cmd.CommandInfo));
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.type === InteractionTypes.APPLICATION_COMMAND && interaction.isChatInputCommand()) {
        await commands.get(interaction.data.name)?.execute(interaction, db);
    } else if (interaction.type === InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE) {
        const command = commands.get(interaction.data.name);
        if (command?.handleAutocomplete) await command.handleAutocomplete(interaction, db);
    }
});

client.connect();