import { ChildProcess, spawn } from "child_process";

export class WhisperManager {
    private static process: ChildProcess | null = null;
    private static isStarting = false;

    static async start() {
        if (this.process || this.isStarting) return;
        this.isStarting = true;

        const binary = process.env.WHISPER_BINARY || "whisper-server";
        const model = process.env.WHISPER_MODEL || "models/ggml-large-v3-turbo.bin";
        const port = process.env.WHISPER_PORT || "8080";

        console.log(`[WHISPER] Starting whisper server: ${binary} with model ${model} on port ${port}`);

        this.process = spawn(binary, ["-m", model, "--port", port], {
            stdio: "inherit"
        });

        this.process.on("exit", (code) => {
            console.log(`[WHISPER] Whisper server exited with code ${code}`);
            this.process = null;
        });

        // Wait a bit for the server to be ready
        // In a more robust implementation, we might poll the health endpoint
        await new Promise(resolve => setTimeout(resolve, 5000));
        this.isStarting = false;
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
}
