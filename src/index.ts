import {ChannelTypes, Client, InteractionTypes, Member, StageChannel, VoiceChannel, Uncached} from "oceanic.js";
import { EndBehaviorType } from "@discordjs/voice";
import {readdirSync} from 'fs';
import {CommandExport} from "./types";
import {drizzle} from 'drizzle-orm/bun-sqlite';
import {notificationChannelLinks, scribeLinks, scribeConsent} from "./db/schema";
import {eq, and} from "drizzle-orm";
import { OpusEncoder } from '@discordjs/opus';
import {spawn} from "child_process";
type VoiceConnection = Awaited<ReturnType<VoiceChannel["join"]>>;
const db = drizzle(process.env.DB_FILE_NAME!);

function prettyTime(ms: number) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    const mDisplay = minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "";
    const sDisplay = seconds > 0 ? `${seconds} second${seconds === 1 ? "" : "s"}` : "";

    return [mDisplay, sDisplay].filter(Boolean).join(" and ") || "0 seconds";
}

// @ts-ignore
const commands = await Promise.all(readdirSync(import.meta.dir+"/commands").map(async (filename) => {
    // @ts-ignore
    const command: CommandExport = (await import(import.meta.dir+"/commands/"+filename)).default;
    return command;
}));
const commandsByName = commands.reduce((acc, command) => {
    acc[command.CommandInfo.name] = command;
    return acc
}, {} as {[name: string]: CommandExport})

const client = new Client({ auth: "Bot " + process.env.TOKEN });

client.on("ready", async() => {
    console.log("Ready as", client.user.tag);
    await client.application.bulkEditGlobalCommands(commands.map((command) => command.CommandInfo))
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.type == InteractionTypes.APPLICATION_COMMAND && interaction.isChatInputCommand()) {
        await commandsByName[interaction.data.name].execute(interaction, db);
    } else if (interaction.type == InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE) {
        const command = commandsByName[interaction.data.name];
        if (command && command.handleAutocomplete) {
            await command.handleAutocomplete(interaction, db);
        }
    };
})

const callStatuses: {[voiceChannelId: string]: {timeout?: ReturnType<typeof setTimeout>, joinTime: number}} = {}

function getVolume(float32Array: Float32Array): number {
    let sum = 0;
    for (const sample of float32Array) {
        sum += sample * sample;
    }
    return Math.sqrt(sum / float32Array.length);
}

async function transcribe(audioBuffer: Buffer<ArrayBuffer>, textChannelId: string, userId: string): Promise<string | void> {
    console.log("new transcription requested...")
    const ffmpeg = spawn("ffmpeg", [
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "-i", "pipe:0",
        "-v", "quiet",
        "-ac", "1",
        "-f", "wav",
        "-" //output to stdout
    ])
    
    ffmpeg.stdin.write(audioBuffer)
    ffmpeg.stdin.end()
    
    const stdoutChunks: Buffer[] = [];

    ffmpeg.stdout.on('data', (data) => {
        stdoutChunks.push(data);
    });
    ffmpeg.on("exit", async () => {
        const audioBlob = new Blob([Buffer.concat(stdoutChunks)], { type: 'audio/wav' });
        const body = new FormData()
        body.set("temperature", "0.0");
        body.set("response_format", "json");
        body.set("temperature_inc", "0.2");
        body.set("file", audioBlob, "rec.wav")
        const response = await fetch("http://127.0.0.1:8080/inference", {
            method: "POST",
            body,
        });
        if (response.ok) {
            console.log("response ok!")
            const data = await response.json();
            if (!("text" in data) || data.text.trim() == "") return;
            const destinationChannel = client.getChannel(textChannelId);
            if (destinationChannel && (destinationChannel.type == ChannelTypes.GUILD_TEXT || destinationChannel.type == ChannelTypes.GUILD_VOICE)) {
                const member = await destinationChannel.guild.getMember(userId);
                if (!member || member == null) return;
                const webhooks = await destinationChannel.getWebhooks();
                if (webhooks.length > 0) {
                    try {
                        webhooks[0].execute({
                            username: member.displayName,
                            avatarURL: member.avatarURL(),
                            content: data.text.trim()
                        });
                    } catch (e) {}
                }
            } 
        } else {
            console.log(response.status)
        }
    })
}

async function speakHandler(userId: string, connection: VoiceConnection, textChannelId: string, voiceChannelId: string) {
    const scribeUsers = await db.select().from(scribeConsent).where(and(
        eq(scribeConsent.userId, userId),
        eq(scribeConsent.voiceChannelId, voiceChannelId)
    ));
    if (scribeUsers.length == 0) {
        return;
    }
    const encoder = new OpusEncoder(48000, 2);
    const audioStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 100 },
    });

    const pcmChunks: Buffer[] = [];

    audioStream.on('data', (chunk) => {
        try {
            pcmChunks.push(encoder.decode(chunk));
        } catch (e) {}
    });

    audioStream.on('end', async () => {
        const fullPcm = Buffer.concat(pcmChunks);
        if (fullPcm.length < 30000) return;

        transcribe(fullPcm, textChannelId, userId) 
    });
}

async function voiceChannelJoin(member: Member, channel: Uncached | VoiceChannel | StageChannel) {
    if (member.id == client.user.id) {return;}
    let voiceChannel: VoiceChannel | StageChannel;
    if (!("voiceMembers" in channel)) {
        let vc = client.getChannel(channel.id)
        if (vc && "voiceMembers" in vc) {
            voiceChannel = vc
        } else {
            return;
        }
    } else {
        voiceChannel = channel
    }

    // Scribe logic
    const scribeLink = await db.select().from(scribeLinks).where(eq(scribeLinks.voiceChannelId, voiceChannel.id));
    if (scribeLink.length > 0) {
        const scribeUsers = await db.select().from(scribeConsent).where(and(
            eq(scribeConsent.userId, member.id),
            eq(scribeConsent.voiceChannelId, voiceChannel.id)
        ));
        if (scribeUsers.length > 0) {
            const vcConnection = await voiceChannel.join({selfMute: true})
            const speakingStartEvent = vcConnection.receiver.speaking.on("start", (userId) => {
                if (userId === member.id) {
                    speakHandler(userId, vcConnection, scribeLink[0].scribeChannelId, voiceChannel.id)
                }
            })
        }
    }

    // Notification logic
    if (voiceChannel.voiceMembers.filter(member => member.id != client.user.id).length != 1) { return; }
    const relatedLinks = await db.select().from(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
    if (relatedLinks.length > 0) {
        const destinationChannel = voiceChannel.guild.channels.find((channel) => channel.id == relatedLinks[0].notifChannelId);
        if (destinationChannel && (destinationChannel.type == ChannelTypes.GUILD_VOICE || destinationChannel.type == ChannelTypes.GUILD_TEXT)) {
            const now = Date.now();
            const timer: ReturnType<typeof setTimeout> = setTimeout(async () => {
                const updatedChannel = client.getChannel(voiceChannel.id)
                if (updatedChannel && updatedChannel.type == ChannelTypes.GUILD_VOICE && updatedChannel.voiceMembers.filter(member => member.id != client.user.id).length >= 1) {
                    const roleId = relatedLinks[0].roleId;
                    await destinationChannel.createMessage({ content: `<@&${roleId}> Call in <#${voiceChannel.id}> started by <@${member.id}>`, allowedMentions: {everyone: false, roles: [roleId], users: false}})
                }
                if (callStatuses[voiceChannel.id]) {
                    delete callStatuses[voiceChannel.id].timeout;
                }
            }, 5000);
            callStatuses[voiceChannel.id] = {timeout: timer, joinTime: now};
        }
    }
}
async function voiceChannelLeave (member: Member, channel: Uncached | VoiceChannel | StageChannel | null) {
    if (member.id == client.user.id) {return;}
    if (!channel) { return; }
    let voiceChannel: VoiceChannel | StageChannel;
    if (!("voiceMembers" in channel)) {
        let vc = client.getChannel(channel.id)
        if (vc && "voiceMembers" in vc) {
            voiceChannel = vc
        } else {
            return;
        }
    } else {
        voiceChannel = channel
    }
    if (voiceChannel.voiceMembers.filter(member => member.id != client.user.id).length != 0) { return; }
    const relatedLinks = await db.select().from(notificationChannelLinks).where(eq(notificationChannelLinks.voiceChannelId, voiceChannel.id));
    if (voiceChannel.voiceMembers.has(client.user.id)) {
        voiceChannel.leave();
    }
    if (relatedLinks.length > 0) {
        if (callStatuses[voiceChannel.id]) {
            const callStatus = callStatuses[voiceChannel.id];
            if (callStatus.timeout) {
                clearTimeout(callStatuses[voiceChannel.id].timeout);
            } else {
                const destinationChannel = voiceChannel.guild.channels.find((channel) => channel.id == relatedLinks[0].notifChannelId);
                if (destinationChannel && (destinationChannel.type == ChannelTypes.GUILD_TEXT || destinationChannel.type == ChannelTypes.GUILD_VOICE)) {
                    await destinationChannel.createMessage({ content: `Call in <#${voiceChannel.id}> ended: lasted for ${prettyTime(Date.now()-callStatus.joinTime)}`, allowedMentions: {everyone: false, roles: false, users: false}})
                }
            }
            delete callStatuses[voiceChannel.id];
        }
    }
}

client.on("voiceChannelJoin", voiceChannelJoin)
client.on("voiceChannelLeave", voiceChannelLeave)
client.on("voiceChannelSwitch", async (member, voiceChannel: Uncached | VoiceChannel | StageChannel, oldVoiceChannel: Uncached | VoiceChannel | StageChannel | null) => {
    await voiceChannelLeave(member, oldVoiceChannel);
    await voiceChannelJoin(member, voiceChannel);
})

client.on("error", (err) => {
    console.error("Something Broke!", err);
});

client.connect();

