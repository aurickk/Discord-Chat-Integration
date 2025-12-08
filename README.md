<p align="center">
<img src="https://github.com/user-attachments/assets/35b66ae1-cfe5-4ecc-ae4a-82d137e3c808" alt="Discord-Chat-Integration-Banner" width="25%"/>
</p>
<h1 align="center">Discord Chat Integration</h1>

<p align="center">Brings your Minecraft chat into Discord. Send messages/commands and listens to Minecraft from Discord without bots. 
</p>


## Features

-  **Control from Discord**: Execute commands and send messages to Minecraft from Discord
-  **Minecraft chat viewing**: Recive Minecraft chat/command feedback in Discord
-  **Client-Side mod**: Mod works entirely on the client, no server modifications needed
-  **Multi-Client Support**: Control and view the chats of multiple Minecraft clients from Discord
-  **Real-Time**: Instant message relay using WebSocket communication
-  **Botless**: Does not require setting up any Discord bots
-  **Discord Plugin**: Supports both BetterDiscord and Vencord
## Demo Video (Vencord)

https://github.com/user-attachments/assets/cfc95f58-096f-4618-a5c4-af739f02f362

## Requirements

- **Minecraft**: 1.21.4 - 1.21.10
- **Fabric Loader**: 0.18.1 or higher
- **Fabric API**: Latest version for 1.21.x
- **Java**: 21 or higher

- **Discord**: Latest MinecraftChat Vencord/BetterDiscord plugin

## Installation

> [!IMPORTANT]
> Both the Discord plugin and the mod are required to be installed.

### Installing the Minecraft Mod

1. Install [Fabric Loader](https://fabricmc.net/use/) for your Minecraft version
2. Download the latest [Fabric API](https://modrinth.com/mod/fabric-api) for your Minecraft version
3. Download the latest `discord-chat-integration-[version]-[mod_version].jar` from the [Releases](https://github.com/aurickk/Discord-Chat-Integration/releases/) page
4. Place both mods in your `.minecraft/mods` folder
5. Launch Minecraft

### Installing the Discord Plugin

 [BetterDiscord Plugin Installation](https://github.com/aurickk/Discord-Chat-Integration/blob/main/betterdiscord-plugin/README.md)

  or

 [Vencord Plugin Installation](https://github.com/aurickk/Discord-Chat-Integration/blob/main/vencord-plugin/minecraftChat/README.md)

## Setup and Configurations

### Quick Settings Access

A **gear icon** appears next to the chat input box when the plugin is enabled. Click it to quickly access the Minecraft Chat settings without navigating through Discord's settings menu. The icon turns **green** when at least one client is connected.

Addional configuration can be found in **User Settings → Vencord/BetterDiscord → Plugins → MinecraftChat**

| Setting | Description | Default |
|---------|-------------|---------|
| **Auto Connect** | Automatically connect to all enabled clients when Discord starts | `true` |
| **Connection Logging Channel** | Discord channel ID where connection/disconnection events are posted (Leave blank to disable) | Empty |
| **Enable Console Logging** | Log plugin debug messages to browser console (DevTools F12) | `true` |

### Adding Minecraft Clients

1. Click **"Add Client"** in the plugin settings (or via the chat bar gear icon)
2. Configure each client:
   - **Name**: A friendly name for this client (e.g., "Main Account", "Alt Account")
   - **Port**: WebSocket port (must match the mod's port, default: `25580`)
   - **Channel ID**: The Discord channel ID to bridge with this client
   - **Enabled**: Toggle to enable/disable this client connection
   - **Forward to Discord**: Toggle to enable/disable forwarding Minecraft chat to Discord

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

The port must be between 1024 and 65535.

## Usage

### Basic Usage

1. Start Minecraft with the mod installed
2. Join a world or server
3. Open Discord with the Vencord plugin enabled 
4. The plugin will automatically connect (if "Auto Connect" is enabled with properly configured client settings)
5. Send messages/commands in the configured Discord channel, they'll appear/execute in Minecraft chat
6. Recieve messages or command feedback in Discord (If "Forward to Discord" is enabled

### Message Format Example

**Discord → Minecraft:**
Messages sent from Discord appear in Minecraft chat and are executed as the player.

**Minecraft → Discord:**
Messages are forwarded in code block format:
```
<PlayerName> message content
```

**Shared Channel Tag:**
When multiple clients share the same Discord channel, messages include a client name tag:
```
[Client Name] <PlayerName> message content
```

### Commands

The mod provides a `/discordchat` command with the following subcommands:

#### `/discordchat` or `/discordchat status`
Shows the current connection status:
- Server status (Running/Stopped)
- Current port
- Number of connected clients

#### `/discordchat port <number>`
Changes the WebSocket server port. Must be between 1024 and 65535.

#### `/discordchat reconnect`
Restarts the WebSocket server. Useful if the connection is lost or after changing the port.

#### `/discordchat disconnect`
Stops the WebSocket server and disconnects all Discord clients. Use `/discordchat reconnect` to reconnect.

### Multi-Client Setup

> [!IMPORTANT]
> Different Minecraft clients cannot share the same port

You can run multiple Minecraft clients, each connected to different or shared Discord channels:

**Different Channels:**
1. **Client 1**: Port `25580` → Discord Channel `123456789`
2. **Client 2**: Port `25581` → Discord Channel `987654321`
3. **Client 3**: Port `25582` → Discord Channel `555555555`

**Shared Channel:**
Multiple clients can be assigned to the same Discord channel. When this happens:
- Messages from Discord are sent to **all** Minecraft clients assigned to that channel
- Messages forwarded to Discord include a `[Client Name]` tag to identify the source

In each Minecraft client:
- Set the port using `/discordchat port <port>`
- Use `/discordchat reconnect` to apply changes

## Building from Source

### Prerequisites

- **Java 21** or higher
- **Gradle** (included via wrapper)

### Building the Minecraft Mod

1. **Clone the repository**
   ```bash
   git clone https://github.com/aurickk/Discord-Chat-Integration.git
   cd Discord-Chat-Integration/
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
2. **Discord Plugin** (Vencord or BetterDiscord) Connects to the mod via WebSockets
3. **Discord Messages** are intercepted by the plugin and sent to Minecraft
4. **Minecraft Messages** are intercepted by mixins and sent to Discord as the user running the plugin (if forwarding enabled)
5. **Multi-client support** allows different Minecraft instances to connect to the same or different Discord channels 

