import { ChildProcess, spawn } from "child_process";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";

type WhisperApiMode = "auto" | "speaches" | "openai" | "whisper.cpp";

export class WhisperManager {
    private static process: ChildProcess | null = null;
    private static isStarting = false;

    static async start() {
        if (this.process || this.isStarting) return;
        this.isStarting = true;

        if (await this.isServerReachable()) {
            this.isStarting = false;
            return;
        }

        if (this.getApiMode() === "speaches" || this.getApiMode() === "openai") {
            console.log(`[WHISPER] External transcription server is not reachable at ${this.getBaseUrl()}`);
            this.isStarting = false;
            return;
        }

        try {
            const binary = process.env.WHISPER_BINARY || "whisper-server";
            const model = await this.ensureWhisperCppModel();
            const port = process.env.WHISPER_PORT || "8080";

            console.log(`[WHISPER] Starting whisper server: ${binary} with model ${model} on port ${port}`);

            this.process = spawn(binary, ["-m", model, "--port", port], {
                stdio: "inherit"
            });

            this.process.on("error", (error) => {
                console.error("[WHISPER] Failed to start whisper server:", error);
                this.process = null;
                this.isStarting = false;
            });

            this.process.on("exit", (code) => {
                console.log(`[WHISPER] Whisper server exited with code ${code}`);
                this.process = null;
                this.isStarting = false;
            });

            await this.waitForServer();
            this.isStarting = false;
        } catch (error) {
            console.error("[WHISPER] Failed to prepare whisper server:", error);
            this.process?.kill();
            this.process = null;
            this.isStarting = false;
        }
    }

    static stop() {
        if (!this.process) return;
        console.log("[WHISPER] Stopping whisper server...");
        this.process.kill();
        this.process = null;
    }

    static isRunning() {
        return this.process !== null || this.isStarting;
    }

    static isStartingUp() {
        return this.isStarting;
    }

    static async transcribe(audio: Blob): Promise<string | null> {
        const failures: string[] = [];

        for (const endpoint of this.getTranscriptionEndpoints()) {
            try {
                const response = await fetch(endpoint.url, {
                    method: "POST",
                    headers: this.getHeaders(),
                    body: endpoint.createBody(audio)
                });

                if (!response.ok) {
                    failures.push(`${endpoint.url}: ${response.status} ${response.statusText}`);
                    continue;
                }

                const text = await this.readTranscriptionText(response);
                if (text) return text;

                failures.push(`${endpoint.url}: empty transcription`);
            } catch (error) {
                failures.push(`${endpoint.url}: ${error}`);
            }
        }

        console.error(`[WHISPER] Transcription failed: ${failures.join("; ")}`);
        return null;
    }

    private static getTranscriptionEndpoints() {
        const baseUrl = this.getBaseUrl();
        const mode = this.getApiMode();
        const endpoints = {
            openai: {
                url: `${baseUrl}/v1/audio/transcriptions`,
                createBody: (audio: Blob) => this.createOpenAiBody(audio)
            },
            whisperCpp: {
                url: `${baseUrl}/inference`,
                createBody: (audio: Blob) => this.createWhisperCppBody(audio)
            }
        };

        if (mode === "speaches" || mode === "openai") return [endpoints.openai];
        if (mode === "whisper.cpp") return [endpoints.whisperCpp];
        return [endpoints.openai, endpoints.whisperCpp];
    }

    private static createOpenAiBody(audio: Blob) {
        const body = new FormData();
        body.set("file", audio, "rec.wav");
        body.set("model", this.getOpenAiModel());
        body.set("response_format", "json");
        body.set("temperature", process.env.WHISPER_TEMPERATURE || "0.0");

        if (process.env.WHISPER_LANGUAGE) body.set("language", process.env.WHISPER_LANGUAGE);

        return body;
    }

    private static createWhisperCppBody(audio: Blob) {
        const body = new FormData();
        body.set("temperature", process.env.WHISPER_TEMPERATURE || "0.0");
        body.set("response_format", "json");
        body.set("temperature_inc", process.env.WHISPER_TEMPERATURE_INC || "0.2");
        body.set("file", audio, "rec.wav");

        return body;
    }

    private static async readTranscriptionText(response: Response) {
        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            const data = await response.json();
            if (typeof data === "object" && data && "text" in data && typeof data.text === "string") {
                return data.text.trim() || null;
            }
            return null;
        }

        const text = await response.text();
        return text.trim() || null;
    }

    private static getHeaders() {
        const apiKey = process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY;
        return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
    }

    private static getApiMode(): WhisperApiMode {
        const mode = (process.env.WHISPER_API || process.env.WHISPER_SERVER_TYPE || "auto").toLowerCase();
        if (mode === "speaches" || mode === "speach") return "speaches";
        if (mode === "openai") return "openai";
        if (mode === "whisper.cpp" || mode === "whispercpp" || mode === "cpp") return "whisper.cpp";
        return "auto";
    }

    private static getBaseUrl() {
        if (process.env.WHISPER_BASE_URL) return process.env.WHISPER_BASE_URL.replace(/\/+$/, "");

        const host = process.env.WHISPER_HOST || "127.0.0.1";
        const port = process.env.WHISPER_PORT || "8080";
        return `http://${host}:${port}`;
    }

    private static getOpenAiModel() {
        if (process.env.WHISPER_TRANSCRIPTION_MODEL) return process.env.WHISPER_TRANSCRIPTION_MODEL;
        if (process.env.SPEACHES_MODEL) return process.env.SPEACHES_MODEL;
        if (process.env.WHISPER_MODEL && !this.looksLikeLocalModelPath(process.env.WHISPER_MODEL)) {
            return process.env.WHISPER_MODEL;
        }

        return "whisper-1";
    }

    private static getWhisperCppModel() {
        return process.env.WHISPER_CPP_MODEL || process.env.WHISPER_MODEL || "models/ggml-large-v3-turbo.bin";
    }

    private static async ensureWhisperCppModel() {
        const model = this.expandHomePath(this.getWhisperCppModel());

        if (!this.looksLikeLocalModelPath(model)) return model;

        try {
            await fs.access(model);
            return model;
        } catch {
            await this.downloadWhisperCppModel(model);
            return model;
        }
    }

    private static async downloadWhisperCppModel(modelPath: string) {
        const modelUrl = this.getWhisperCppModelUrl(modelPath);
        const tempPath = `${modelPath}.download`;

        if (!modelUrl) {
            throw new Error(`[WHISPER] Model file not found at ${modelPath}, and no WHISPER_MODEL_URL was configured.`);
        }

        await fs.mkdir(path.dirname(modelPath), { recursive: true });
        await fs.rm(tempPath, { force: true });

        console.log(`[WHISPER] Downloading model from ${modelUrl}`);
        const response = await fetch(modelUrl);
        if (!response.ok || !response.body) {
            throw new Error(`[WHISPER] Failed to download model: ${response.status} ${response.statusText}`);
        }

        await pipeline(response.body, createWriteStream(tempPath));
        await fs.rename(tempPath, modelPath);
        console.log(`[WHISPER] Model downloaded to ${modelPath}`);
    }

    private static getWhisperCppModelUrl(modelPath: string) {
        if (process.env.WHISPER_CPP_MODEL_URL) return process.env.WHISPER_CPP_MODEL_URL;
        if (process.env.WHISPER_MODEL_URL) return process.env.WHISPER_MODEL_URL;

        const fileName = path.basename(modelPath);
        if (fileName.startsWith("ggml-") && fileName.endsWith(".bin")) {
            return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${encodeURIComponent(fileName)}`;
        }

        return null;
    }

    private static expandHomePath(filePath: string) {
        if (filePath === "~") return process.env.HOME || filePath;
        if (filePath.startsWith("~/") && process.env.HOME) return path.join(process.env.HOME, filePath.slice(2));
        return filePath;
    }

    private static looksLikeLocalModelPath(model: string) {
        return model.startsWith("/") ||
            model.startsWith("./") ||
            model.startsWith("../") ||
            model.startsWith("~/") ||
            model.startsWith("models/") ||
            model.endsWith(".bin");
    }

    private static async isServerReachable() {
        try {
            await fetch(this.getBaseUrl(), { signal: AbortSignal.timeout(1000) });
            return true;
        } catch {
            return false;
        }
    }

    private static async waitForServer() {
        const startedAt = Date.now();

        while (Date.now() - startedAt < 5000) {
            if (await this.isServerReachable()) return;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
}
