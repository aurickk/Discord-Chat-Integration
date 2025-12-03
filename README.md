
<p align="center">

<img src="https://github.com/user-attachments/assets/005d99c0-08d2-46e5-ac38-72ed71396427" alt="Discord-Chat-Integration-Logo" width="25%"/>
</p>
<h1 align="center">Discord Chat Integration</h1>

<p align="center">A client-side Minecraft Fabric mod that bridges Discord channel chat with your Minecraft client, allowing you to send messages from Discord to Minecraft in real-time without Discord bots.
</p>

## Features

-  **Forwarding to minecraft**: Send messages or commands from Discord to Minecraft
-  **Client-Side Only**: Works entirely on the client - no server modifications needed
-  **Multi-Client Support**: Connect multiple Minecraft clients to different Discord channels
-  **Real-Time**: Instant message relay using WebSocket communication
-  **Channel-Specific**: Each client can be configured to listen to a specific Discord channel
-  **Command Support**: Send Minecraft commands directly from Discord
-  **Easy Configuration**: Simple GUI-based settings in Vencord plugin
-  **Status Monitoring**: Check connection status with in-game commands
## Demo Video 

https://github.com/user-attachments/assets/d0eb6e7f-7e2e-495b-bcd3-779163c09aef

## Requirements


### Minecraft Mod
- **Minecraft**: 1.21 - 1.21.10
- **Fabric Loader**: 0.18.1 or higher
- **Fabric API**: Latest version for 1.21.x
- **Java**: 21 or higher

### Vencord Plugin
- **Vencord**: Latest version
- **Discord**: Desktop client/Browser extension

## Installation

> [!IMPORTANT]
> Both the Vencord plugin and the mod are required to be installed.

### Minecraft Mod

1. **Download the mod**
   - Download the latest `discord-chat-integration-*.jar` from [Releases](https://github.com/aurickk/Discord-Chat-Integration/releases)
   - Or build from source (see [Building from Source](#building-from-source))

2. **Install Fabric Loader**
   - Download and install [Fabric Loader](https://fabricmc.net/use/) for Minecraft 1.21.x
   - Make sure to also install Fabric API

3. **Install the mod**
   - Place the mod JAR file in your `.minecraft/mods` folder

### Custom Vencord Plugin

Because this is not an official Vencord plugin, you must rebuild and inject Vencord with the plugin.

1. Install [Node.js](https://nodejs.org/en), [git](https://git-scm.com/install/), and [pnpm](https://pnpm.io/installation) if missing.

2. Run:

```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install --frozen-lockfile
```

3. Create a folder called `minecraftChat` in `/Vencord/src/plugins`.

4. Download and move the [MinecraftChat](https://github.com/aurickk/Discord-Chat-Integration/tree/main/vencord-plugin/minecraftChat) `index.tsx` into the newly created `minecraftChat` folder.

5. Run:
```sh
pnpm build
pnpm inject
```
6. If built and injected successfully, follow the remaining prompt(s) and restart Discord to apply changes.
7. In Discord's Vencord plugins menu, enable the MinecraftChat Plugin.



## Configuration

### Vencord Plugin Settings

The demo video showcased part of the configuration process.

After enabling the plugin, configure it in **User Settings → Vencord → Plugins → MinecraftChat**:

| Setting | Description |
|---------|-------------|
| **Auto Connect** | Automatically connect to all enabled clients when Discord starts
| **Show Connection Messages** | Display connection status messages in console

### Adding Minecraft Clients

1. Click **"Add Client"** in the plugin settings
2. Configure each client:
   - **Name**: A friendly name for this client (e.g., "Main Account", "Alt Account")
   - **Port**: WebSocket port (must match the mod's port, default: `25580`)
   - **Channel ID**: The Discord channel ID to bridge with this client
   - **Enabled**: Toggle to enable/disable this client

3. **Getting a Channel ID**:
   - Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
   - Right-click on the channel you want to use
   - Click "Copy Channel ID"
   - Paste into the plugin settings

### Minecraft Mod Configuration

The mod uses a default port of `25580`. You can change this using the in-game command:

```
/discordchat port <port_number>
```
> [!IMPORTANT]
> Clients much have different port numbers so they must be unique.


## Usage

### Basic Usage

1. **Start Minecraft** with the mod installed
2. **Join a world or server**
3. **Open Discord** with the Vencord plugin enabled
4. The plugin will automatically connect (if Auto Connect is enabled)
Configure the plugin settings to match your Minecraft client port>
5. **Send messages** in the configured Discord channel - they'll appear in Minecraft chat
6. **Type in Minecraft chat** - messages will appear in the Discord channel

### Commands

The mod provides a `/discordchat` command with the following subcommands:

#### `/discordchat` or `/discordchat status`
Shows the current connection status:
- Server status (Running/Stopped)
- Current port
- Number of connected clients

#### `/discordchat port <number>`
Changes the WebSocket server port. Must be between 1024 and 65535.

Example:
```
/discordchat port 25581
```

#### `/discordchat reconnect`
Restarts the WebSocket server. Useful if the connection is lost or after changing the port.

### Multi-Client Setup

You can run multiple Minecraft clients, each connected to different Discord channels:

1. **Client 1**: Port `25580` → Discord Channel `123456789`
2. **Client 2**: Port `25581` → Discord Channel `987654321`
3. **Client 3**: Port `25582` → Discord Channel `555555555`

In each Minecraft client:
- Set the port using `/discordchat port <port>`
- Use `/discordchat reconnect` to apply changes

In Vencord plugin settings:
- Add multiple clients with different ports and channel IDs
- Enable/disable clients as needed

## Building the mod from Source

### Prerequisites

- **Java 21** or higher
- **Gradle** (included via wrapper)

### Building the Minecraft Mod

1. **Clone the repository**
   ```bash
   git clone https://github.com/aurickk/Discord-Chat-Integration.git
   cd Discord-Chat-Integration
   ```

2. **Build the mod**
   ```bash
   # Windows
   .\gradlew.bat build
   
   # Linux/Mac
   ./gradlew build
   ```

3. **Find the built mod**
   - The mod JAR will be in `build/libs/discord-chat-integration-*.jar`


## How It Works

1. **Minecraft Mod** runs a WebSocket server on localhost (default port 25580)
2. **Vencord Plugin** connects to the WebSocket server as a client
3. **Discord Messages** are intercepted by the plugin and sent to Minecraft via WebSocket
4. **Multi-client support** allows different Minecraft instances to connect to different Discord channels

