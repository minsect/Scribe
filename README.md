# MiScrobe
Discord bot to notify when a user joins a voice chat, and to transcribe their words.

## Usage
Requirements: 
- [Node.js >20](https://nodejs.org/)
- [Whisper.cpp server](https://github.com/ggml-org/whisper.cpp)
- [ffmpeg](https://www.ffmpeg.org/)
- A decent computer for the AI model (recommended at least 4GB vram)
- An internet connection
1. Download the source code (use git clone maybe?)
2. Make a .env file in the root directory of the bot (next to package.json), then configure it.
   1. `TOKEN`: The discord bot token. this is required for it to function.
   2. `DB_FILE_NAME`: The filename for the SQLite database, also required.
3. Run `npm install` to install all the required packages.
4. Run `npx drizzle-kit push` to initialize the database.
5. Download an AI model compatible with whisper.cpp and run it (find some [here](https://huggingface.co/ggerganov/whisper.cpp/tree/main))
6. Run the whisper.cpp server with the model.
5. Run `npm start` or `node src/index.ts`.

## Dissecting The Code
### index.ts
`src/index.ts` holds the main logic for the bot.
This contains the voice chat join and leave events, and the suboptimal command handler.
### types.ts
`src/types.ts` just holds the one type for the commands. I was hoping to put more types, but it is what it is.
### commands
`src/commands` holds all the slash command logic for the bot. 
You will find many subcommands (e.g. `src/commands/link-commands.ts`) to be handled in 1 TypeScript file.
This is because I was too lazy to make proper directory handling, this was good enough.

### db
There is only `src/db/schema.ts`. This is where the types for the tables in the SQLite database exist.

`src/drizzle.config.ts` holds the configuration for drizzle, the ORM used in this project. You can change the type of DB used here (e.g. from sqlite to PostgreSQL)

## Credits
Thank you to the people who made [Node.js](https://nodejs.org/).

Thank you contributors of [Oceanic](https://github.com/OceanicJS/Oceanic) for your discord library, this is great.

Thank you to people who made [Whisper.cpp](https://github.com/ggml-org/whisper.cpp), this project is great

Thank you Snazzah for making [Davey](https://github.com/Snazzah/davey), having this dependency fixes all issues with discord opus.
