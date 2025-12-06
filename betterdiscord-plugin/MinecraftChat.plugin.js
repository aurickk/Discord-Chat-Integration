/**
 * @name MinecraftChat
 * @author Aurick
 * @authorId 1348025017233047634
 * @version 1.0.1
 * @description Bridge Discord channel chat with multiple Minecraft clients via WebSocket
 * @website https://github.com/aurickk/minecraft-chat-integration
 * @source https://github.com/aurickk/minecraft-chat-integration
 */

module.exports = class MinecraftChat {
    constructor() {
        this.defaultSettings = {
            autoConnect: true,
            connectionLoggingChannel: "",
            enableConsoleLogging: true,
            clientProperties: "[]"
        };
        
        // WebSocket connections - Map of client ID to WebSocket
        this.wsConnections = new Map();
        this.reconnectIntervals = new Map();
        this.isConnecting = new Map();
        
        // Store player names per client
        this.playerNames = new Map();
        
        // Track disconnect messages sent
        this.disconnectMessageSent = new Map();
        
        // Track nonces of messages sent by this Discord client
        this.sentMessageNonces = new Set();
        
        // Track message content forwarded from Minecraft to Discord
        this.forwardedToDiscordMessages = new Set();
        
        // Track processed Discord message IDs
        this.processedDiscordMessageIds = new Set();
        
        // Message queue for ordered forwarding
        this.messageQueues = new Map();
        this.isSendingMessage = new Map();
        
        // Flux subscription status
        this.isSubscribed = false;
        
        // Observer for chat bar button
        this.observer = null;
        
        // Status refresh interval
        this.statusRefreshInterval = null;
        
        // Bound handler for Discord messages
        this.boundHandleDiscordMessage = this.handleDiscordMessage.bind(this);
    }

    getName() { return "MinecraftChat"; }
    getAuthor() { return "Aurick"; }
    getDescription() { return "Bridge Discord channel chat with multiple Minecraft clients via WebSocket"; }
    getVersion() { return "1.0.0"; }

    load() {
        // Load settings
        this.settings = BdApi.Data.load(this.getName(), "settings") || { ...this.defaultSettings };
    }

    start() {
        this.log("Plugin starting...");

        // Add chat bar button
        this.addChatBarButton();

        // Subscribe to Discord events
        if (!this.isSubscribed) {
            const Dispatcher = BdApi.Webpack.getModule(m => m.dispatch && m.subscribe);
            if (Dispatcher) {
                Dispatcher.subscribe("MESSAGE_CREATE", this.boundHandleDiscordMessage);
                this.isSubscribed = true;
            }
        }

        // Auto-connect if enabled
        if (this.settings.autoConnect) {
            setTimeout(() => {
                const clients = this.getClients();
                for (const client of clients) {
                    if (client.enabled) {
                        this.connectWebSocket(client);
                    }
                }
            }, 2000);
        }

        this.log("Plugin started!");
    }

    stop() {
        this.log("Plugin stopping...");

        // Remove chat bar button
        this.removeChatBarButton();

        // Unsubscribe from Discord events
        if (this.isSubscribed) {
            const Dispatcher = BdApi.Webpack.getModule(m => m.dispatch && m.subscribe);
            if (Dispatcher) {
                Dispatcher.unsubscribe("MESSAGE_CREATE", this.boundHandleDiscordMessage);
                this.isSubscribed = false;
            }
        }

        // Clear tracked data
        this.sentMessageNonces.clear();
        this.processedDiscordMessageIds.clear();
        this.forwardedToDiscordMessages.clear();
        this.disconnectMessageSent.clear();

        // Disconnect all WebSockets
        this.disconnectAllWebSockets();

        this.log("Plugin stopped!");
    }

    log(message, ...args) {
        if (this.settings.enableConsoleLogging) {
            console.log(`[MinecraftChat] ${message}`, ...args);
        }
    }

    saveSettings() {
        BdApi.Data.save(this.getName(), "settings", this.settings);
    }

    // ============== SETTINGS MANAGEMENT ==============

    getClients() {
        try {
            const clientsJson = this.settings.clientProperties || "[]";
            return JSON.parse(clientsJson);
        } catch (e) {
            console.error("[MinecraftChat] Error parsing clients:", e);
            return [];
        }
    }

    saveClients(clients) {
        try {
            const json = JSON.stringify(clients);
            this.settings.clientProperties = json;
            this.saveSettings();
            this.log(`Saved clients: ${clients.length} client(s)`);
        } catch (e) {
            console.error("[MinecraftChat] Error saving clients:", e);
        }
    }

    // ============== CONNECTION LOGGING ==============

    async sendLogToDiscord(content) {
        const logChannelId = this.settings.connectionLoggingChannel;
        if (!logChannelId) return;

        try {
            const ChannelStore = BdApi.Webpack.getModule(m => m.getChannel && m.getDMFromUserId);
            const channel = ChannelStore?.getChannel(logChannelId);
            if (!channel) {
                console.error(`[MinecraftChat] Log channel ${logChannelId} not found`);
                return;
            }

            const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            this.sentMessageNonces.add(nonce);

            const MessageActions = BdApi.Webpack.getModule(m => m.sendMessage && m._sendMessage);
            if (MessageActions) {
                MessageActions.sendMessage(channel.id, {
                    content: content,
                    tts: false,
                    invalidEmojis: [],
                    validNonShortcutEmojis: []
                }, undefined, { nonce });
            }
        } catch (e) {
            console.error(`[MinecraftChat] Error sending log message:`, e);
        }
    }

    getConnectedClientsList() {
        const clients = this.getClients();
        const connectedClients = clients.filter(client => {
            const ws = this.wsConnections.get(client.id);
            return ws && ws.readyState === WebSocket.OPEN;
        });

        if (connectedClients.length === 0) return "None";

        return connectedClients.map(client => {
            const playerName = this.playerNames.get(client.id);
            return playerName
                ? `• ${client.name} (${playerName})`
                : `• ${client.name}`;
        }).join("\n");
    }

    // ============== WEBSOCKET MANAGEMENT ==============

    connectWebSocket(client, attemptedPort) {
        const existingWs = this.wsConnections.get(client.id);
        if (existingWs?.readyState === WebSocket.OPEN || this.isConnecting.get(client.id)) {
            return;
        }

        this.isConnecting.set(client.id, true);
        const portToUse = attemptedPort ?? client.port;

        try {
            const ws = new WebSocket(`ws://127.0.0.1:${portToUse}`);
            this.wsConnections.set(client.id, ws);

            ws.onopen = () => {
                this.isConnecting.set(client.id, false);

                if (portToUse !== client.port) {
                    const clients = this.getClients();
                    const updated = clients.map(c =>
                        c.id === client.id ? { ...c, port: portToUse } : c
                    );
                    this.saveClients(updated);
                    this.log(`Port ${client.port} was taken for "${client.name}". Using port ${portToUse} instead.`);
                }

                this.log(`Client "${client.name}" connected on port ${portToUse}`);

                const interval = this.reconnectIntervals.get(client.id);
                if (interval) {
                    clearInterval(interval);
                    this.reconnectIntervals.delete(client.id);
                }

                // Update chat button color
                this.updateChatButtonColor();
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMinecraftMessage(data, client.id);
                } catch (e) {
                    this.log(`Error parsing message from ${client.name}:`, e);
                }
            };

            ws.onclose = (event) => {
                this.isConnecting.set(client.id, false);

                // Port conflict handling
                if (event.code === 1006 && portToUse === client.port) {
                    const clients = this.getClients();
                    const usedPorts = new Set(clients.filter(c => c.id !== client.id).map(c => c.port));

                    let alternativePort = client.port + 1;
                    let attempts = 0;
                    const maxAttempts = 10;

                    while (attempts < maxAttempts && (usedPorts.has(alternativePort) || alternativePort > 65535)) {
                        alternativePort++;
                        attempts++;
                    }

                    if (attempts < maxAttempts && alternativePort <= 65535) {
                        this.log(`Port ${client.port} appears to be in use for "${client.name}". Trying port ${alternativePort}...`);
                        setTimeout(() => this.connectWebSocket(client, alternativePort), 1000);
                        return;
                    }
                }

                this.log(`Client "${client.name}" disconnected (code: ${event.code})`);

                // Send disconnect message once per disconnect cycle
                if (!this.disconnectMessageSent.get(client.id)) {
                    this.disconnectMessageSent.set(client.id, true);
                    const connectedList = this.getConnectedClientsList();
                    this.sendLogToDiscord(`❌ **Client Disconnected**\n**Client:** ${client.name}\n\n**Connected Clients:**\n${connectedList}`);
                }

                // Auto-reconnect
                if (this.settings.autoConnect && client.enabled && !this.reconnectIntervals.has(client.id)) {
                    const interval = setInterval(() => {
                        const currentWs = this.wsConnections.get(client.id);
                        if (!currentWs || currentWs.readyState === WebSocket.CLOSED) {
                            const clients = this.getClients();
                            const updatedClient = clients.find(c => c.id === client.id);
                            if (updatedClient?.enabled) {
                                this.log(`Attempting to reconnect "${client.name}"...`);
                                this.connectWebSocket(updatedClient);
                            } else {
                                clearInterval(interval);
                                this.reconnectIntervals.delete(client.id);
                            }
                        }
                    }, 5000);
                    this.reconnectIntervals.set(client.id, interval);
                }

                // Update chat button color
                this.updateChatButtonColor();
            };

            ws.onerror = (error) => {
                this.log(`WebSocket error for "${client.name}" on port ${portToUse}:`, error);
            };
        } catch (e) {
            this.isConnecting.set(client.id, false);
            this.log(`Failed to create WebSocket for "${client.name}":`, e);
        }
    }

    disconnectWebSocket(clientId) {
        const interval = this.reconnectIntervals.get(clientId);
        if (interval) {
            clearInterval(interval);
            this.reconnectIntervals.delete(clientId);
        }

        const ws = this.wsConnections.get(clientId);
        if (ws) {
            ws.close(1000, "Client disabled");
            this.wsConnections.delete(clientId);
        }

        this.disconnectMessageSent.delete(clientId);
        this.updateChatButtonColor();
    }

    disconnectAllWebSockets() {
        for (const clientId of this.wsConnections.keys()) {
            this.disconnectWebSocket(clientId);
        }
    }

    // ============== MESSAGE HANDLING ==============

    hasMultipleClientsForChannel(channelId) {
        const clients = this.getClients();
        const clientsUsingChannel = clients.filter(c =>
            c.channelId === channelId &&
            c.enabled &&
            (c.forwardToDiscord ?? false)
        );
        return clientsUsingChannel.length > 1;
    }

    handleMinecraftMessage(data, clientId) {
        const clients = this.getClients();
        const client = clients.find(c => c.id === clientId);
        if (!client) {
            this.log(`Received message from unknown client ID: ${clientId}`);
            return;
        }

        if (data.type === "connection_status") {
            this.log(`Minecraft mod (${client.name}): ${data.message}`);

            const newPlayerName = data.playerName;
            const isValidPlayerName = newPlayerName && newPlayerName !== "Unknown" && newPlayerName.trim() !== "";

            if (isValidPlayerName) {
                const previousPlayerName = this.playerNames.get(clientId);
                const isNewOrReconnect = this.disconnectMessageSent.get(clientId) === true || !this.playerNames.has(clientId);

                this.playerNames.set(clientId, newPlayerName);
                this.log(`Stored player name for ${client.name}: ${newPlayerName}`);

                if (isNewOrReconnect || previousPlayerName !== newPlayerName) {
                    this.disconnectMessageSent.set(clientId, false);
                    const connectedList = this.getConnectedClientsList();
                    this.sendLogToDiscord(`✅ **Client Connected**\n**Client:** ${client.name}\n**Player:** ${newPlayerName}\n\n**Connected Clients:**\n${connectedList}`);
                    this.log(`Sent connection log for ${client.name} (${newPlayerName})`);
                }
            } else {
                this.log(`Waiting for player name for ${client.name}...`);
            }
        } else if (data.type === "pong") {
            this.log(`Received pong from ${client.name}`);
        } else if (data.type === "minecraft_message") {
            const freshClients = this.getClients();
            const freshClient = freshClients.find(c => c.id === clientId);
            if (!freshClient) return;

            const shouldForward = (freshClient.forwardToDiscord ?? false) && freshClient.channelId;
            if (!shouldForward) return;

            const author = data.author || "Minecraft";
            const content = data.content || "";
            if (!content) return;

            const playerName = this.playerNames.get(clientId);
            if (playerName) {
                const isOwnMessage =
                    content.startsWith(`<${playerName}>`) ||
                    (author !== "System" && author !== "Minecraft" && author === playerName);

                if (isOwnMessage) {
                    this.log(`Skipping own message from ${playerName}`);
                    return;
                }
            }

            let plainText = author !== "System" && author !== "Minecraft"
                ? `${author}: ${content}`
                : content;

            const multipleClients = this.hasMultipleClientsForChannel(freshClient.channelId);
            if (multipleClients) {
                plainText = `[${freshClient.name}] ${plainText}`;
            }

            const isMultiLine = plainText.includes("\n");
            const messageText = isMultiLine
                ? `\`\`\`\n${plainText}\n\`\`\``
                : `\`${plainText}\``;

            if (!this.messageQueues.has(clientId)) {
                this.messageQueues.set(clientId, []);
            }
            this.messageQueues.get(clientId).push({
                plainText,
                messageText,
                channelId: freshClient.channelId,
                clientName: freshClient.name
            });

            this.processMessageQueue(clientId);
        }
    }

    async processMessageQueue(clientId) {
        if (this.isSendingMessage.get(clientId)) return;

        const queue = this.messageQueues.get(clientId);
        if (!queue || queue.length === 0) return;

        this.isSendingMessage.set(clientId, true);

        const ChannelStore = BdApi.Webpack.getModule(m => m.getChannel && m.getDMFromUserId);
        const MessageActions = BdApi.Webpack.getModule(m => m.sendMessage && m._sendMessage);

        while (queue.length > 0) {
            const message = queue.shift();

            try {
                const channel = ChannelStore?.getChannel(message.channelId);
                if (!channel) {
                    console.error(`[MinecraftChat] Channel ${message.channelId} not found for client ${message.clientName}`);
                    continue;
                }

                const messageKey = `${message.channelId}:${message.plainText}`;
                this.forwardedToDiscordMessages.add(messageKey);

                if (this.forwardedToDiscordMessages.size > 100) {
                    const entriesArray = Array.from(this.forwardedToDiscordMessages);
                    this.forwardedToDiscordMessages.clear();
                    entriesArray.slice(-50).forEach(key => this.forwardedToDiscordMessages.add(key));
                }

                setTimeout(() => this.forwardedToDiscordMessages.delete(messageKey), 5000);

                const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
                this.sentMessageNonces.add(nonce);

                if (MessageActions) {
                    await new Promise((resolve) => {
                        MessageActions.sendMessage(channel.id, {
                            content: message.messageText,
                            tts: false,
                            invalidEmojis: [],
                            validNonShortcutEmojis: []
                        }, undefined, { nonce });
                        setTimeout(resolve, 100);
                    });
                }
            } catch (e) {
                console.error(`[MinecraftChat] Error sending message to Discord channel ${message.channelId}:`, e);
            }
        }

        this.isSendingMessage.set(clientId, false);
    }

    sendToMinecraft(author, content, channelId, messageId) {
        const clients = this.getClients();
        const matchingClients = clients.filter(c => c.channelId === channelId && c.enabled);

        if (matchingClients.length === 0) return;

        const message = {
            type: "discord_message",
            author: author,
            content: content
        };

        if (messageId) {
            message.messageId = messageId;
        }

        const messageJson = JSON.stringify(message);

        for (const client of matchingClients) {
            const ws = this.wsConnections.get(client.id);
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(messageJson);
                } catch (e) {
                    console.error(`[MinecraftChat] Error sending message to ${client.name}:`, e);
                }
            }
        }
    }

    handleDiscordMessage(event) {
        if (!event.message) return;

        const message = event.message;
        const channelId = message.channel_id;
        const messageId = message.id;

        if (messageId && this.processedDiscordMessageIds.has(messageId)) return;

        const clients = this.getClients();
        const matchingClients = clients.filter(c => c.channelId === channelId && c.enabled);
        if (matchingClients.length === 0) return;

        if (messageId) {
            this.processedDiscordMessageIds.add(messageId);
            if (this.processedDiscordMessageIds.size > 1000) {
                const idsArray = Array.from(this.processedDiscordMessageIds);
                this.processedDiscordMessageIds.clear();
                idsArray.slice(-500).forEach(id => this.processedDiscordMessageIds.add(id));
            }
        }

        if (message.nonce && this.sentMessageNonces.has(message.nonce)) {
            this.sentMessageNonces.delete(message.nonce);
            return;
        }

        const UserStore = BdApi.Webpack.getModule(m => m.getCurrentUser && m.getUser);
        const currentUserId = UserStore?.getCurrentUser()?.id;
        const authorId = message.author?.id;
        const isCurrentUser = currentUserId && authorId === currentUserId;

        if (isCurrentUser && (message.pending || message.state === "SENDING" || message.failed)) {
            return;
        }

        const messageContent = message.content || "";
        if (messageContent) {
            let plainContent = messageContent;
            if (plainContent.startsWith('```') && plainContent.endsWith('```')) {
                plainContent = plainContent.slice(3, -3).trim();
            } else {
                plainContent = plainContent.replace(/^`+|`+$/g, '');
            }
            const messageKey = `${channelId}:${plainContent}`;
            if (this.forwardedToDiscordMessages.has(messageKey)) {
                this.forwardedToDiscordMessages.delete(messageKey);
                return;
            }
        }

        if (!messageContent) return;

        const authorName = message.author?.username || "Unknown";
        this.sendToMinecraft(authorName, messageContent, channelId, messageId);
    }

    // ============== CHAT BAR BUTTON ==============

    addChatBarButton() {
        const chatBarSelector = '[class*="channelTextArea"] [class*="buttons"]';
        this.observer = new MutationObserver(() => {
            const chatBar = document.querySelector(chatBarSelector);
            if (chatBar && !chatBar.querySelector('.minecraft-chat-button')) {
                this.injectChatButton(chatBar);
            }
        });

        this.observer.observe(document.body, { childList: true, subtree: true });

        // Initial injection
        setTimeout(() => {
            const chatBar = document.querySelector(chatBarSelector);
            if (chatBar) {
                this.injectChatButton(chatBar);
            }
        }, 1000);
    }

    removeChatBarButton() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }

        const existingButton = document.querySelector('.minecraft-chat-button');
        if (existingButton) {
            existingButton.remove();
        }
    }

    injectChatButton(chatBar) {
        if (chatBar.querySelector('.minecraft-chat-button')) return;

        const hasConnection = this.hasAnyConnection();

        const button = document.createElement('div');
        button.className = 'minecraft-chat-button';
        button.title = 'Minecraft Chat Settings';
        button.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            cursor: pointer;
            border-radius: 4px;
            margin: 0 4px;
        `;

        button.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="color: ${hasConnection ? '#3ba55c' : '#b5bac1'}">
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
        `;

        button.addEventListener('click', () => this.openSettingsModal());
        button.addEventListener('mouseenter', () => {
            button.style.backgroundColor = 'var(--background-modifier-hover)';
        });
        button.addEventListener('mouseleave', () => {
            button.style.backgroundColor = 'transparent';
        });

        chatBar.insertBefore(button, chatBar.firstChild);
    }

    hasAnyConnection() {
        const clients = this.getClients();
        return clients.some(c => {
            const ws = this.wsConnections.get(c.id);
            return ws && ws.readyState === WebSocket.OPEN && c.enabled;
        });
    }

    updateChatButtonColor() {
        const button = document.querySelector('.minecraft-chat-button svg');
        if (button) {
            button.style.color = this.hasAnyConnection() ? '#3ba55c' : '#b5bac1';
        }
    }

    // ============== SETTINGS MODAL ==============

    openSettingsModal() {
        const modalHTML = this.createModalHTML();

        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'minecraft-chat-modal-overlay';
        modalOverlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10000;
        `;

        modalOverlay.innerHTML = modalHTML;

        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                if (this.statusRefreshInterval) {
                    clearInterval(this.statusRefreshInterval);
                }
                modalOverlay.remove();
            }
        });

        document.body.appendChild(modalOverlay);

        // Setup event listeners
        this.setupModalEventListeners(modalOverlay);

        // Start status refresh
        this.startStatusRefresh(modalOverlay);
    }

    createModalHTML() {
        const clients = this.getClients();

        let clientsHTML = '';
        if (clients.length === 0) {
            clientsHTML = `
                <div style="text-align: center; padding: 20px; color: #b5bac1; border: 1px dashed #4f545c; border-radius: 8px;">
                    No clients configured. Click "Add Client" to get started.
                </div>
            `;
        } else {
            clientsHTML = clients.map(client => this.createClientCardHTML(client)).join('');
        }

        return `
            <div class="minecraft-chat-modal" style="
                background: #313338;
                border-radius: 8px;
                width: 500px;
                max-height: 80vh;
                overflow: hidden;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
            ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 16px;
                    border-bottom: 1px solid #4f545c;
                ">
                    <h2 style="margin: 0; color: #fff; font-size: 20px; font-weight: 600;">Minecraft Chat Settings</h2>
                    <button class="modal-close-btn" style="
                        background: none;
                        border: none;
                        color: #b5bac1;
                        cursor: pointer;
                        font-size: 24px;
                        padding: 0;
                        line-height: 1;
                    ">&times;</button>
                </div>
                <div style="padding: 16px; max-height: calc(80vh - 60px); overflow-y: auto;">
                    <!-- Global Settings -->
                    <div style="margin-bottom: 16px; padding: 12px; background: #2b2d31; border-radius: 8px; border: 1px solid #4f545c;">
                        <div style="margin-bottom: 10px; font-weight: 600; color: #fff;">Global Settings</div>
                        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
                            <label style="display: flex; align-items: center; gap: 6px; color: #b5bac1; font-size: 13px; cursor: pointer;">
                                <input type="checkbox" class="auto-connect-checkbox" ${this.settings.autoConnect ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;">
                                Auto Connect on Discord startup
                            </label>
                        </div>
                        <div>
                            <label style="display: block; margin-bottom: 4px; color: #b5bac1; font-size: 12px;">Connection Logging Channel ID</label>
                            <input type="text" class="log-channel-input" value="${this.settings.connectionLoggingChannel || ''}" placeholder="Enter channel ID for connection logs" style="
                                width: 100%;
                                padding: 8px;
                                color: #fff;
                                background: #1e1f22;
                                border: 1px solid #4f545c;
                                border-radius: 4px;
                                box-sizing: border-box;
                            ">
                        </div>
                    </div>

                    <!-- Client Management -->
                    <div style="margin-bottom: 12px;">
                        <button class="add-client-btn" style="
                            padding: 8px 16px;
                            color: #fff;
                            background: #3ba55c;
                            border: none;
                            border-radius: 4px;
                            cursor: pointer;
                            font-weight: 500;
                        ">+ Add Client</button>
                    </div>
                    <div class="clients-container">
                        ${clientsHTML}
                    </div>
                </div>
            </div>
        `;
    }

    createClientCardHTML(client) {
        const ws = this.wsConnections.get(client.id);
        let statusText = 'Disconnected';
        let statusColor = '#ed4245';

        if (ws) {
            if (ws.readyState === WebSocket.CONNECTING) {
                statusText = 'Connecting...';
                statusColor = '#faa61a';
            } else if (ws.readyState === WebSocket.OPEN) {
                const playerName = this.playerNames.get(client.id);
                statusText = playerName ? `Connected (${playerName})` : 'Connected';
                statusColor = '#3ba55c';
            } else if (ws.readyState === WebSocket.CLOSING) {
                statusText = 'Closing...';
                statusColor = '#faa61a';
            }
        }

        return `
            <div class="client-card" data-client-id="${client.id}" style="
                border: 1px solid #4f545c;
                padding: 12px;
                margin-bottom: 12px;
                border-radius: 8px;
                background: #2b2d31;
            ">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <strong style="color: #fff; font-size: 14px;">${client.name}</strong>
                    <button class="remove-client-btn" data-client-id="${client.id}" style="
                        padding: 4px 12px;
                        color: #fff;
                        background: #ed4245;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    ">Remove</button>
                </div>
                <div style="display: grid; gap: 8px;">
                    <div>
                        <label style="display: block; margin-bottom: 4px; color: #b5bac1; font-size: 12px;">Name</label>
                        <input type="text" class="client-name-input" data-client-id="${client.id}" value="${client.name}" style="
                            width: 100%;
                            padding: 8px;
                            color: #fff;
                            background: #1e1f22;
                            border: 1px solid #4f545c;
                            border-radius: 4px;
                            box-sizing: border-box;
                        ">
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                        <div>
                            <label style="display: block; margin-bottom: 4px; color: #b5bac1; font-size: 12px;">Port</label>
                            <input type="text" class="client-port-input" data-client-id="${client.id}" value="${client.port}" style="
                                width: 100%;
                                padding: 8px;
                                color: #fff;
                                background: #1e1f22;
                                border: 1px solid #4f545c;
                                border-radius: 4px;
                                box-sizing: border-box;
                            ">
                        </div>
                        <div>
                            <label style="display: block; margin-bottom: 4px; color: #b5bac1; font-size: 12px;">Channel ID</label>
                            <input type="text" class="client-channel-input" data-client-id="${client.id}" value="${client.channelId}" placeholder="Enter channel ID" style="
                                width: 100%;
                                padding: 8px;
                                color: #fff;
                                background: #1e1f22;
                                border: 1px solid #4f545c;
                                border-radius: 4px;
                                box-sizing: border-box;
                            ">
                        </div>
                    </div>
                    <div style="display: flex; gap: 16px; margin-top: 4px;">
                        <label style="display: flex; align-items: center; gap: 6px; color: #b5bac1; font-size: 13px; cursor: pointer;">
                            <input type="checkbox" class="client-enabled-checkbox" data-client-id="${client.id}" ${client.enabled ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;">
                            Enabled
                        </label>
                        <label style="display: flex; align-items: center; gap: 6px; color: #b5bac1; font-size: 13px; cursor: pointer;">
                            <input type="checkbox" class="client-forward-checkbox" data-client-id="${client.id}" ${client.forwardToDiscord ? 'checked' : ''} style="cursor: pointer; width: 16px; height: 16px;">
                            Forward to Discord
                        </label>
                    </div>
                    <div class="client-status" data-client-id="${client.id}" style="font-size: 12px; color: #b5bac1; margin-top: 4px;">
                        Status: <span style="color: ${statusColor}; font-weight: 500;">${statusText}</span>
                    </div>
                </div>
            </div>
        `;
    }

    setupModalEventListeners(modalOverlay) {
        // Close button
        modalOverlay.querySelector('.modal-close-btn').addEventListener('click', () => {
            if (this.statusRefreshInterval) {
                clearInterval(this.statusRefreshInterval);
            }
            modalOverlay.remove();
        });

        // Auto connect checkbox
        modalOverlay.querySelector('.auto-connect-checkbox').addEventListener('change', (e) => {
            this.settings.autoConnect = e.target.checked;
            this.saveSettings();
        });

        // Log channel input
        modalOverlay.querySelector('.log-channel-input').addEventListener('blur', (e) => {
            this.settings.connectionLoggingChannel = e.target.value;
            this.saveSettings();
        });

        // Add client button
        modalOverlay.querySelector('.add-client-btn').addEventListener('click', () => {
            this.addClient(modalOverlay);
        });

        // Setup client event listeners
        this.setupClientEventListeners(modalOverlay);
    }

    setupClientEventListeners(modalOverlay) {
        // Remove client buttons
        modalOverlay.querySelectorAll('.remove-client-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const clientId = e.target.dataset.clientId;
                this.removeClient(clientId, modalOverlay);
            });
        });

        // Client name inputs
        modalOverlay.querySelectorAll('.client-name-input').forEach(input => {
            input.addEventListener('blur', (e) => {
                const clientId = e.target.dataset.clientId;
                this.updateClient(clientId, { name: e.target.value }, modalOverlay);
            });
        });

        // Client port inputs
        modalOverlay.querySelectorAll('.client-port-input').forEach(input => {
            input.addEventListener('blur', (e) => {
                const clientId = e.target.dataset.clientId;
                const port = parseInt(e.target.value) || 0;
                this.updateClient(clientId, { port }, modalOverlay);
            });
        });

        // Client channel inputs
        modalOverlay.querySelectorAll('.client-channel-input').forEach(input => {
            input.addEventListener('blur', (e) => {
                const clientId = e.target.dataset.clientId;
                this.updateClient(clientId, { channelId: e.target.value }, modalOverlay);
            });
        });

        // Client enabled checkboxes
        modalOverlay.querySelectorAll('.client-enabled-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const clientId = e.target.dataset.clientId;
                this.updateClient(clientId, { enabled: e.target.checked }, modalOverlay);
            });
        });

        // Client forward checkboxes
        modalOverlay.querySelectorAll('.client-forward-checkbox').forEach(checkbox => {
            checkbox.addEventListener('change', (e) => {
                const clientId = e.target.dataset.clientId;
                this.updateClient(clientId, { forwardToDiscord: e.target.checked }, modalOverlay);
            });
        });
    }

    startStatusRefresh(modalOverlay) {
        this.statusRefreshInterval = setInterval(() => {
            const clients = this.getClients();
            clients.forEach(client => {
                const statusEl = modalOverlay.querySelector(`.client-status[data-client-id="${client.id}"] span`);
                if (statusEl) {
                    const ws = this.wsConnections.get(client.id);
                    let statusText = 'Disconnected';
                    let statusColor = '#ed4245';

                    if (ws) {
                        if (ws.readyState === WebSocket.CONNECTING) {
                            statusText = 'Connecting...';
                            statusColor = '#faa61a';
                        } else if (ws.readyState === WebSocket.OPEN) {
                            const playerName = this.playerNames.get(client.id);
                            statusText = playerName ? `Connected (${playerName})` : 'Connected';
                            statusColor = '#3ba55c';
                        } else if (ws.readyState === WebSocket.CLOSING) {
                            statusText = 'Closing...';
                            statusColor = '#faa61a';
                        }
                    }

                    statusEl.textContent = statusText;
                    statusEl.style.color = statusColor;
                }
            });
        }, 1000);
    }

    addClient(modalOverlay) {
        const clients = this.getClients();
        const newClient = {
            id: `client_${Date.now()}`,
            name: `Client ${clients.length + 1}`,
            port: 25580 + clients.length,
            channelId: "",
            enabled: true,
            forwardToDiscord: false
        };

        clients.push(newClient);
        this.saveClients(clients);

        // Re-render clients container
        const container = modalOverlay.querySelector('.clients-container');
        container.innerHTML = clients.map(c => this.createClientCardHTML(c)).join('');

        // Re-setup event listeners
        this.setupClientEventListeners(modalOverlay);
    }

    removeClient(clientId, modalOverlay) {
        this.disconnectWebSocket(clientId);
        this.playerNames.delete(clientId);

        const clients = this.getClients().filter(c => c.id !== clientId);
        this.saveClients(clients);

        // Re-render clients container
        const container = modalOverlay.querySelector('.clients-container');
        if (clients.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 20px; color: #b5bac1; border: 1px dashed #4f545c; border-radius: 8px;">
                    No clients configured. Click "Add Client" to get started.
                </div>
            `;
        } else {
            container.innerHTML = clients.map(c => this.createClientCardHTML(c)).join('');
        }

        // Re-setup event listeners
        this.setupClientEventListeners(modalOverlay);
    }

    updateClient(clientId, updates, modalOverlay) {
        const clients = this.getClients();
        const oldClient = clients.find(c => c.id === clientId);
        const updated = clients.map(c =>
            c.id === clientId ? { ...c, ...updates } : c
        );

        this.saveClients(updated);

        const newClient = updated.find(c => c.id === clientId);
        if (!newClient) return;

        const portChanged = oldClient && oldClient.port !== newClient.port;
        const enabledChanged = oldClient && oldClient.enabled !== newClient.enabled;

        if (portChanged || (enabledChanged && !newClient.enabled)) {
            this.disconnectWebSocket(clientId);
        }

        if (newClient.enabled && (!this.wsConnections.has(clientId) || portChanged || enabledChanged)) {
            setTimeout(() => this.connectWebSocket(newClient), 100);
        }

        // Update card title if name changed
        if (updates.name) {
            const card = modalOverlay.querySelector(`.client-card[data-client-id="${clientId}"]`);
            if (card) {
                const title = card.querySelector('strong');
                if (title) title.textContent = updates.name;
            }
        }
    }

    // ============== BETTERDISCORD SETTINGS PANEL ==============

    getSettingsPanel() {
        const panel = document.createElement('div');
        panel.style.cssText = 'padding: 10px; color: #ffffff;';

        const settingsHTML = `
            <div style="margin-bottom: 16px;">
                <h3 style="color: #fff; margin-bottom: 8px;">General Settings</h3>
                <div style="margin-bottom: 10px;">
                    <label style="display: flex; align-items: center; gap: 8px; color: #b5bac1; cursor: pointer;">
                        <input type="checkbox" id="mc-auto-connect" ${this.settings.autoConnect ? 'checked' : ''}>
                        Auto Connect on Discord startup
                    </label>
                </div>
                <div style="margin-bottom: 10px;">
                    <label style="display: block; margin-bottom: 4px; color: #b5bac1;">Connection Logging Channel ID</label>
                    <input type="text" id="mc-log-channel" value="${this.settings.connectionLoggingChannel || ''}" placeholder="Enter channel ID" style="
                        width: 100%;
                        padding: 8px;
                        background: var(--input-background);
                        border: 1px solid var(--input-border);
                        border-radius: 4px;
                        color: #fff;
                        box-sizing: border-box;
                    ">
                </div>
                <div style="margin-bottom: 10px;">
                    <label style="display: flex; align-items: center; gap: 8px; color: #b5bac1; cursor: pointer;">
                        <input type="checkbox" id="mc-console-logging" ${this.settings.enableConsoleLogging ? 'checked' : ''}>
                        Enable Console Logging
                    </label>
                </div>
            </div>
            <div style="margin-bottom: 16px;">
                <h3 style="color: #fff; margin-bottom: 8px;">Client Management</h3>
                <p style="color: #b5bac1; font-size: 13px;">Use the gear button in the chat bar for full client management, or open the settings modal from there.</p>
                <button id="mc-open-modal" style="
                    margin-top: 8px;
                    padding: 8px 16px;
                    background: #5865f2;
                    color: #fff;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                ">Open Client Settings</button>
            </div>
            <div>
                <h3 style="color: #fff; margin-bottom: 8px;">Quick Actions</h3>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button id="mc-connect-all" style="
                        padding: 8px 16px;
                        background: #3ba55c;
                        color: #fff;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                    ">Connect All</button>
                    <button id="mc-disconnect-all" style="
                        padding: 8px 16px;
                        background: #ed4245;
                        color: #fff;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                    ">Disconnect All</button>
                </div>
            </div>
        `;

        panel.innerHTML = settingsHTML;

        // Event listeners
        panel.querySelector('#mc-auto-connect').addEventListener('change', (e) => {
            this.settings.autoConnect = e.target.checked;
            this.saveSettings();
        });

        panel.querySelector('#mc-log-channel').addEventListener('blur', (e) => {
            this.settings.connectionLoggingChannel = e.target.value;
            this.saveSettings();
        });

        panel.querySelector('#mc-console-logging').addEventListener('change', (e) => {
            this.settings.enableConsoleLogging = e.target.checked;
            this.saveSettings();
        });

        panel.querySelector('#mc-open-modal').addEventListener('click', () => {
            this.openSettingsModal();
        });

        panel.querySelector('#mc-connect-all').addEventListener('click', () => {
            const clients = this.getClients();
            for (const client of clients) {
                if (client.enabled) {
                    this.connectWebSocket(client);
                }
            }
            BdApi.showToast('Connecting to all enabled clients...', { type: 'info' });
        });

        panel.querySelector('#mc-disconnect-all').addEventListener('click', () => {
            this.disconnectAllWebSockets();
            BdApi.showToast('Disconnected all clients', { type: 'success' });
        });

        return panel;
    }
};

