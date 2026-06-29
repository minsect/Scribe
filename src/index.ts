import { Client, ChannelTypes, InteractionTypes, Member, StageChannel, VoiceChannel } from "oceanic.js";
import type { ExecuteWebhookOptions, Uncached } from "oceanic.js";
import { EndBehaviorType, joinVoiceChannel } from "@discordjs/voice";
import type { VoiceConnection } from "@discordjs/voice";
import fs from "fs/promises";
import path from "path";
import type { CommandExport } from "./types.ts";
import { drizzle } from 'drizzle-orm/libsql';
import { notificationChannelLinks, scribeLinks, scribeConsent } from "./db/schema.ts";
import { eq, and } from "drizzle-orm";
import pkg from '@discordjs/opus';
const { OpusEncoder } = pkg;
import { spawn } from "child_process";
import { WhisperManager } from "./whisper.ts";

process.loadEnvFile(".env")

const client = new Client({ auth: "Bot " + process.env.TOKEN });
const db = drizzle("file:" + process.env.DB_FILE_NAME!);
const daveDecryptionFailureTolerance = Number.parseInt(process.env.DAVE_DECRYPTION_FAILURE_TOLERANCE ?? "250", 10);
const activeSpeechStreams = new Set<string>();
const scribeReceiverChannels = new Set<string>();

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
    let totalPending = 0;
    for (const [textChannelId, messages] of queue.entries()) {
        totalPending += messages.length;
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

    // Check if we should stop whisper
    if (totalPending === 0 && WhisperManager.isRunning()) {
        const activeConnections = Array.from(client.guilds.values()).some(guild =>
            Array.from(guild.channels.values()).some(ch =>
                (ch.type === ChannelTypes.GUILD_VOICE || ch.type === ChannelTypes.GUILD_STAGE_VOICE) && "voiceMembers" in ch && ch.voiceMembers.has(client.user.id)
            )
        );
        if (!activeConnections) {
            WhisperManager.stop();
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

function joinScribeVoiceChannel(voiceChannel: VoiceChannel | StageChannel) {
    return joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfMute: true,
        selfDeaf: false,
        debug: true,
        daveEncryption: true,
        decryptionFailureTolerance: Number.isFinite(daveDecryptionFailureTolerance) ? daveDecryptionFailureTolerance : 250
    });
}

function enqueuePlaceholder(textChannelId: string, uuid?: string) {
    if (!queue.has(textChannelId)) queue.set(textChannelId, []);

    const placeholder: { content?: ExecuteWebhookOptions, executing?: boolean } = {};

    queue.get(textChannelId)!.push(placeholder);
    return placeholder;
}
async function transcribe(audioBuffer: Buffer<ArrayBuffer>, textChannelId: string, userId: string) {

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
        const text = await WhisperManager.transcribe(audioBlob);
        if (!text) return;

        // Update placeholder
        placeholder.content = {
            username: member.displayName,
            avatarURL: member.avatarURL(),
            content: text
        };
    });
}

async function speakHandler(userId: string, connection: VoiceConnection, textChannelId: string, voiceChannelId: string) {
    const streamKey = `${voiceChannelId}:${userId}`;
    if (activeSpeechStreams.has(streamKey)) return;

    const scribeUsers = await db.select().from(scribeConsent).where(and(
        eq(scribeConsent.userId, userId),
        eq(scribeConsent.voiceChannelId, voiceChannelId)
    ));
    if (scribeUsers.length === 0) return;

    activeSpeechStreams.add(streamKey);
    const encoder = new OpusEncoder(48000, 2);
    const audioStream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    audioStream.on('error', (error) => {
        console.error(`[ERROR] Audio stream error for user ${userId}:`, error);
        activeSpeechStreams.delete(streamKey);
    });
    
    const pcmChunks: Buffer[] = [];
    let silenceTimer: NodeJS.Timeout | null = null;

    const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
            await onEnd();
            audioStream.destroy();
        }, 100);
    };

    // Start the initial timer
    resetSilenceTimer();

    audioStream.on('data', (chunk: Buffer) => {
        // Check if the chunk contains any non-zero data (actual audio)
        const isSilent = chunk.every((byte: number) => byte === 0);
        
        if (!isSilent && chunk.length > 0) {
            resetSilenceTimer();
        }
        
        try { pcmChunks.push(encoder.decode(chunk)); } catch {}
    });

    let ended = false;
    const onEnd = async () => {
        if (ended) return;
        ended = true;
        activeSpeechStreams.delete(streamKey);
        
        if (silenceTimer) clearTimeout(silenceTimer);
        const fullPcm = Buffer.concat(pcmChunks);
        if (fullPcm.length < 30000) return;
        transcribe(fullPcm, textChannelId, userId);
    };

    audioStream.on('end', onEnd);
    audioStream.on('close', onEnd);
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
            await WhisperManager.start();
            if (voiceChannel.voiceMembers.filter(m => m.id !== client.user.id).length === 0) return;
            const vcConnection = joinScribeVoiceChannel(voiceChannel);
            if (!scribeReceiverChannels.has(voiceChannel.id)) {
                scribeReceiverChannels.add(voiceChannel.id);
                vcConnection.receiver.speaking.on("start", (userId) => {
                    speakHandler(userId, vcConnection, scribeLink[0].scribeChannelId, voiceChannel.id);
                });
            }
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
    if (voiceChannel.voiceMembers.has(client.user.id)) {
        scribeReceiverChannels.delete(voiceChannel.id);
        for (const streamKey of activeSpeechStreams) {
            if (streamKey.startsWith(`${voiceChannel.id}:`)) activeSpeechStreams.delete(streamKey);
        }
        voiceChannel.leave();
    }

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
