import { definePluginSettings } from "@api/Settings";
import { addChatBarButton, removeChatBarButton, ChatBarButton } from "@api/ChatButtons";
import { openModal, ModalRoot, ModalHeader, ModalContent, ModalCloseButton, ModalSize } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, useState, useEffect, useRef, UserStore } from "@webpack/common";
import { ChannelStore, RestAPI, Constants, Text } from "@webpack/common";

// Client configuration interface
interface ClientConfig {
    id: string;
    name: string;
    port: number;
    channelId: string;
    enabled: boolean;
    forwardToDiscord?: boolean; // Per-client forwarding setting
}

// WebSocket connections - Map of client ID to WebSocket
const wsConnections = new Map<string, WebSocket>();
const reconnectIntervals = new Map<string, ReturnType<typeof setInterval>>();
const isConnecting = new Map<string, boolean>();

// Store player names per client - Map of client ID to player name
// This map persists across reconnection attempts to prevent "Unknown" issues
const playerNames = new Map<string, string>();

// Track if we've already sent a disconnect message for each client
// Prevents spam when reconnection attempts fail repeatedly
const disconnectMessageSent = new Map<string, boolean>();

// Track nonces of messages sent by this Discord client
const sentMessageNonces = new Set<string>();

// Track message content we're forwarding from Minecraft to Discord
const forwardedToDiscordMessages = new Set<string>();

// Track processed Discord message IDs to prevent duplicates
const processedDiscordMessageIds = new Set<string>();

// Message queue for ordered forwarding to Discord (per client)
const messageQueues = new Map<string, Array<{ plainText: string; messageText: string; channelId: string; clientName: string }>>();
const isSendingMessage = new Map<string, boolean>();

// Track if we're already subscribed to prevent multiple subscriptions
let isSubscribed = false;

const settings = definePluginSettings({
    autoConnect: {
        type: OptionType.BOOLEAN,
        description: "Automatically connect to all enabled clients on Discord startup",
        default: true,
        restartNeeded: false,
    },
    connectionLoggingChannel: {
        type: OptionType.STRING,
        description: "Discord channel ID where connection/disconnection events are posted",
        default: "",
        restartNeeded: false,
    },
    enableConsoleLogging: {
        type: OptionType.BOOLEAN,
        description: "Log plugin debug messages to browser console (DevTools F12)",
        default: true,
        restartNeeded: false,
    },
    clientProperties: {
        type: OptionType.STRING,
        description: "Stores client information, do not edit.",
        default: "[]",
        restartNeeded: false,
    },
});

function log(message: string, ...args: any[]) {
    if (settings.store.enableConsoleLogging) {
        console.log(`[MinecraftChat] ${message}`, ...args);
    }
}

// Send log message to Discord channel
async function sendLogToDiscord(content: string) {
    const logChannelId = settings.store.connectionLoggingChannel;
    if (!logChannelId) {
        return; // Log channel not configured
    }
    
    try {
        const channel = ChannelStore.getChannel(logChannelId);
        if (!channel) {
            console.error(`[MinecraftChat] Log channel ${logChannelId} not found`);
            return;
        }
        
        // Generate nonce and track it to prevent loops
        const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
        sentMessageNonces.add(nonce);
        
        // Send message using Discord REST API
        await RestAPI.post({
            url: Constants.Endpoints.MESSAGES(channel.id),
            body: {
                content: content,
                flags: 0,
                mobile_network_type: "unknown",
                nonce: nonce,
                tts: false,
            }
        });
    } catch (e) {
        console.error(`[MinecraftChat] Error sending log message to Discord channel ${logChannelId}:`, e);
    }
}

// Get list of connected clients
function getConnectedClientsList(): string {
    const clients = getClients();
    const connectedClients = clients.filter(client => {
        const ws = wsConnections.get(client.id);
        return ws && ws.readyState === WebSocket.OPEN;
    });
    
    if (connectedClients.length === 0) {
        return "None";
    }
    
    return connectedClients.map(client => {
        const playerName = playerNames.get(client.id);
        return playerName 
            ? `• ${client.name} (${playerName})`
            : `• ${client.name}`;
    }).join("\n");
}

function getClients(): ClientConfig[] {
    try {
        const clientsJson = settings.store.clientProperties || "[]";
        const clients: ClientConfig[] = JSON.parse(clientsJson);
        return clients;
    } catch (e) {
        console.error("[MinecraftChat] Error parsing clients:", e);
        return [];
    }
}

function saveClients(clients: ClientConfig[]) {
    try {
        const json = JSON.stringify(clients);
        settings.store.clientProperties = json;
        log(`Saved clients: ${clients.length} client(s)`);
    } catch (e) {
        console.error("[MinecraftChat] Error saving clients:", e);
    }
}

function connectWebSocket(client: ClientConfig, attemptedPort?: number): void {
    const existingWs = wsConnections.get(client.id);
    if (existingWs?.readyState === WebSocket.OPEN || isConnecting.get(client.id)) {
        return;
    }

    isConnecting.set(client.id, true);
    
    // Use attempted port if provided (for port conflict resolution), otherwise use configured port
    const portToUse = attemptedPort ?? client.port;

    try {
        const ws = new WebSocket(`ws://127.0.0.1:${portToUse}`);
        wsConnections.set(client.id, ws);

        ws.onopen = () => {
            isConnecting.set(client.id, false);
            // Don't reset disconnectMessageSent here - we'll reset it after receiving player name
            // This allows handleMinecraftMessage to know this is a new/reconnection
            
            // If we used a different port due to conflict, update the client config and notify
            if (portToUse !== client.port) {
                const clients = getClients();
                const updated = clients.map(c => 
                    c.id === client.id ? { ...c, port: portToUse } : c
                );
                saveClients(updated);
                log(`Port ${client.port} was taken for "${client.name}". Using port ${portToUse} instead.`);
            }
            
            log(`Client "${client.name}" connected on port ${portToUse}`);
            
            // Clear reconnect interval if we successfully connected
            const interval = reconnectIntervals.get(client.id);
            if (interval) {
                clearInterval(interval);
                reconnectIntervals.delete(client.id);
            }
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleMinecraftMessage(data, client.id);
            } catch (e) {
                log(`Error parsing message from ${client.name}:`, e);
            }
        };

        ws.onclose = (event) => {
            isConnecting.set(client.id, false);
            
            // If connection was refused (port in use) and we haven't tried alternative ports, try next port
            if (event.code === 1006 && portToUse === client.port) {
                const clients = getClients();
                const usedPorts = new Set(clients
                    .filter(c => c.id !== client.id)
                    .map(c => c.port)
                );
                
                // Find next available port
                let alternativePort = client.port + 1;
                let attempts = 0;
                const maxAttempts = 10;
                
                while (attempts < maxAttempts && (usedPorts.has(alternativePort) || alternativePort > 65535)) {
                    alternativePort++;
                    attempts++;
                }
                
                if (attempts < maxAttempts && alternativePort <= 65535) {
                    log(`Port ${client.port} appears to be in use for "${client.name}". Trying port ${alternativePort}...`);
                    setTimeout(() => {
                        connectWebSocket(client, alternativePort);
                    }, 1000);
                    return;
                }
            }
            
            log(`Client "${client.name}" disconnected (code: ${event.code})`);
            
            // Only send disconnect message once per disconnect cycle (not on every reconnect attempt)
            if (!disconnectMessageSent.get(client.id)) {
                disconnectMessageSent.set(client.id, true);
                const connectedList = getConnectedClientsList();
                sendLogToDiscord(`❌ **Client Disconnected**\n**Client:** ${client.name}\n\n**Connected Clients:**\n${connectedList}`);
            }

            // Try to reconnect if auto-connect is enabled and client is still enabled
            if (settings.store.autoConnect && client.enabled && !reconnectIntervals.has(client.id)) {
                const interval = setInterval(() => {
                    const currentWs = wsConnections.get(client.id);
                    if (!currentWs || currentWs.readyState === WebSocket.CLOSED) {
                        const clients = getClients();
                        const updatedClient = clients.find(c => c.id === client.id);
                        if (updatedClient?.enabled) {
                            log(`Attempting to reconnect "${client.name}"...`);
                            connectWebSocket(updatedClient);
                        } else {
                            clearInterval(interval);
                            reconnectIntervals.delete(client.id);
                        }
                    }
                }, 5000);
                reconnectIntervals.set(client.id, interval);
            }
        };

        ws.onerror = (error) => {
            log(`WebSocket error for "${client.name}" on port ${portToUse}:`, error);
        };
    } catch (e) {
        isConnecting.set(client.id, false);
        log(`Failed to create WebSocket for "${client.name}":`, e);
    }
}

function disconnectWebSocket(clientId: string) {
    const interval = reconnectIntervals.get(clientId);
    if (interval) {
        clearInterval(interval);
        reconnectIntervals.delete(clientId);
    }

    const ws = wsConnections.get(clientId);
    if (ws) {
        ws.close(1000, "Client disabled");
        wsConnections.delete(clientId);
    }
    
    // Don't delete player name here - keep it for status display
    // It will be updated when connection is re-established
    disconnectMessageSent.delete(clientId);
}

function disconnectAllWebSockets() {
    for (const clientId of wsConnections.keys()) {
        disconnectWebSocket(clientId);
    }
}

// Check if multiple clients share the same channel for forwarding
function hasMultipleClientsForChannel(channelId: string): boolean {
    const clients = getClients();
    const clientsUsingChannel = clients.filter(c => 
        c.channelId === channelId && 
        c.enabled && 
        (c.forwardToDiscord ?? false)
    );
    return clientsUsingChannel.length > 1;
}

function handleMinecraftMessage(data: any, clientId: string) {
    // Get fresh client config to ensure we have latest settings
    const clients = getClients();
    const client = clients.find(c => c.id === clientId);
    if (!client) {
        log(`Received message from unknown client ID: ${clientId}`);
        return;
    }
    
    if (data.type === "connection_status") {
        log(`Minecraft mod (${client.name}): ${data.message}`);
        
        // Store player name if provided and valid (not empty, not "Unknown")
        const newPlayerName = data.playerName;
        const isValidPlayerName = newPlayerName && newPlayerName !== "Unknown" && newPlayerName.trim() !== "";
        
        if (isValidPlayerName) {
            const previousPlayerName = playerNames.get(clientId);
            const isNewOrReconnect = disconnectMessageSent.get(clientId) === true || !playerNames.has(clientId);
            
            playerNames.set(clientId, newPlayerName);
            log(`Stored player name for ${client.name}: ${newPlayerName}`);
            
            // Send connection log message when:
            // 1. This is a new connection (no previous player name)
            // 2. This is a reconnection after disconnect (disconnectMessageSent was true)
            // 3. Player name changed (different account)
            if (isNewOrReconnect || previousPlayerName !== newPlayerName) {
                // Reset disconnect flag since we're now connected
                disconnectMessageSent.set(clientId, false);
                
                const connectedList = getConnectedClientsList();
                sendLogToDiscord(`✅ **Client Connected**\n**Client:** ${client.name}\n**Player:** ${newPlayerName}\n\n**Connected Clients:**\n${connectedList}`);
                log(`Sent connection log for ${client.name} (${newPlayerName})`);
            }
        } else {
            // No valid player name yet - wait for update
            log(`Waiting for player name for ${client.name}...`);
        }
    } else if (data.type === "pong") {
        log(`Received pong from ${client.name}`);
    } else if (data.type === "minecraft_message") {
        // Read fresh config to get current forwardToDiscord and channelId values
        const freshClients = getClients();
        const freshClient = freshClients.find(c => c.id === clientId);
        if (!freshClient) return;
        
        // Check per-client forwardToDiscord setting (defaults to false if not set)
        const shouldForward = (freshClient.forwardToDiscord ?? false) && freshClient.channelId;
        if (!shouldForward) {
            return;
        }
        
        const author = data.author || "Minecraft";
        const content = data.content || "";
        
        if (!content) return;
        
        // Check if this message is from the connected player themselves
        // Skip forwarding own messages to avoid seeing them twice in Discord
        const playerName = playerNames.get(clientId);
        if (playerName) {
            // Check various formats: "PlayerName: message" or "<PlayerName> message"
            const isOwnMessage = 
                content.startsWith(`<${playerName}>`) ||
                (author !== "System" && author !== "Minecraft" && author === playerName);
            
            if (isOwnMessage) {
                log(`Skipping own message from ${playerName}`);
                return;
            }
        }
        
        // Format message
        let plainText = author !== "System" && author !== "Minecraft" 
            ? `${author}: ${content}`
            : content;
        
        // Add [client name] tag if multiple clients share this channel
        const multipleClients = hasMultipleClientsForChannel(freshClient.channelId);
        if (multipleClients) {
            plainText = `[${freshClient.name}] ${plainText}`;
        }
        
        // Check if message contains newlines (multi-line)
        const isMultiLine = plainText.includes("\n");
        
        // Wrap in triple backticks for multi-line, single backticks for single-line
        const messageText = isMultiLine 
            ? `\`\`\`\n${plainText}\n\`\`\``
            : `\`${plainText}\``;
        
        // Queue message for ordered sending to Discord
        if (!messageQueues.has(clientId)) {
            messageQueues.set(clientId, []);
        }
        messageQueues.get(clientId)!.push({ plainText, messageText, channelId: freshClient.channelId, clientName: freshClient.name });
        
        // Process queue if not already processing
        processMessageQueue(clientId);
    }
}

// Process message queue for a specific client (ensures messages are sent in order)
async function processMessageQueue(clientId: string) {
    // If already processing messages for this client, return
    if (isSendingMessage.get(clientId)) {
        return;
    }
    
    const queue = messageQueues.get(clientId);
    if (!queue || queue.length === 0) {
        return;
    }
    
    // Mark as processing
    isSendingMessage.set(clientId, true);
    
    // Process all messages in queue sequentially
    while (queue.length > 0) {
        const message = queue.shift()!;
        
        try {
            // Get the channel object to ensure it exists
            const channel = ChannelStore.getChannel(message.channelId);
            if (!channel) {
                console.error(`[MinecraftChat] Channel ${message.channelId} not found for client ${message.clientName}`);
                continue;
            }
            
            // Track this message content to prevent it from being sent back to Minecraft
            const messageKey = `${message.channelId}:${message.plainText}`;
            forwardedToDiscordMessages.add(messageKey);
            
            // Clean up old entries periodically (keep last 100)
            if (forwardedToDiscordMessages.size > 100) {
                const entriesArray = Array.from(forwardedToDiscordMessages);
                forwardedToDiscordMessages.clear();
                entriesArray.slice(-50).forEach(key => forwardedToDiscordMessages.add(key));
            }
            
            // Remove the key after 5 seconds to prevent memory leaks
            setTimeout(() => forwardedToDiscordMessages.delete(messageKey), 5000);
            
            // Generate nonce and track it to prevent loops
            const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            sentMessageNonces.add(nonce);
            
            // Send message using Discord REST API (await to ensure order)
            await RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channel.id),
                body: {
                    content: message.messageText,
                    flags: 0,
                    mobile_network_type: "unknown",
                    nonce: nonce,
                    tts: false,
                }
            });
            
        } catch (e) {
            console.error(`[MinecraftChat] Error sending message to Discord channel ${message.channelId}:`, e);
        }
    }
    
    // Mark as done processing
    isSendingMessage.set(clientId, false);
}

function sendToMinecraft(author: string, content: string, channelId: string, messageId?: string) {
    // Find ALL clients that handle this channel (multiple clients can share a channel)
    const clients = getClients();
    const matchingClients = clients.filter(c => c.channelId === channelId && c.enabled);
    
    if (matchingClients.length === 0) {
        return;
    }

    const message: any = {
        type: "discord_message",
        author: author,
        content: content,
    };
    
    if (messageId) {
        message.messageId = messageId;
    }

    const messageJson = JSON.stringify(message);

    // Send to all matching clients
    for (const client of matchingClients) {
        const ws = wsConnections.get(client.id);
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(messageJson);
            } catch (e) {
                console.error(`[MinecraftChat] Error sending message to ${client.name}:`, e);
            }
        }
    }
}

// Track nonces of messages sent by this client to prevent loops
function handleMessageSend(event: any) {
    if (event.nonce) {
        sentMessageNonces.add(event.nonce);
        
        // Clean up old nonces periodically (keep last 500)
        if (sentMessageNonces.size > 1000) {
            const noncesArray = Array.from(sentMessageNonces);
            sentMessageNonces.clear();
            noncesArray.slice(-500).forEach(nonce => sentMessageNonces.add(nonce));
        }
    }
}

function handleDiscordMessage(event: any) {
    if (!event.message) {
        return;
    }

    const message = event.message;
    const channelId = message.channel_id;
    const messageId = message.id;

    // Deduplication: Check if we've already processed this message ID (check FIRST)
    if (messageId && processedDiscordMessageIds.has(messageId)) {
        return;
    }

    // Find which clients handle this channel (multiple clients can share a channel)
    const clients = getClients();
    const matchingClients = clients.filter(c => c.channelId === channelId && c.enabled);
    
    if (matchingClients.length === 0) {
        return;
    }
    
    // Mark as processed IMMEDIATELY to prevent race conditions
    if (messageId) {
        processedDiscordMessageIds.add(messageId);
        // Clean up old message IDs periodically
        if (processedDiscordMessageIds.size > 1000) {
            const idsArray = Array.from(processedDiscordMessageIds);
            processedDiscordMessageIds.clear();
            idsArray.slice(-500).forEach(id => processedDiscordMessageIds.add(id));
        }
    }
    
    // Prevent loops: check if message was sent by this Discord client
    // Method 1: Check nonce (most reliable)
    if (message.nonce && sentMessageNonces.has(message.nonce)) {
        sentMessageNonces.delete(message.nonce);
        return;
    }
    
    // Method 2: Check optimistic/pending flags
    const currentUserId = UserStore.getCurrentUser()?.id;
    const authorId = message.author?.id;
    const isCurrentUser = currentUserId && authorId === currentUserId;
    
    if (isCurrentUser && (message.pending || message.state === "SENDING" || message.failed)) {
        return;
    }
    
    // Method 3: Check if message was recently forwarded from Minecraft
    const messageContent = message.content || "";
    if (messageContent) {
        // Remove code block formatting (both single and triple backticks) for comparison
        let plainContent = messageContent;
        // Remove triple backticks code block (```\ncontent\n```)
        if (plainContent.startsWith('```') && plainContent.endsWith('```')) {
            plainContent = plainContent.slice(3, -3).trim();
        } else {
            // Remove single backticks
            plainContent = plainContent.replace(/^`+|`+$/g, '');
        }
        const messageKey = `${channelId}:${plainContent}`;
        if (forwardedToDiscordMessages.has(messageKey)) {
            forwardedToDiscordMessages.delete(messageKey);
            return;
        }
    }

    if (!messageContent) {
        return;
    }

    // Get author name
    const authorName = message.author?.username || "Unknown";

    // Forward message to all matching Minecraft clients
    sendToMinecraft(authorName, messageContent, channelId, messageId);
}

// Settings modal content - reuses the ClientsManager component
function SettingsModalContent({ onClose }: { onClose: () => void }) {
    const [clients, setClients] = useState<ClientConfig[]>(getClients());
    const [statusRefresh, setStatusRefresh] = useState(0);
    const [autoConnect, setAutoConnect] = useState(settings.store.autoConnect);
    const [logChannel, setLogChannel] = useState(settings.store.connectionLoggingChannel || "");
    const [portInputs, setPortInputs] = useState<Map<string, string>>(() => {
        const map = new Map<string, string>();
        clients.forEach(c => map.set(c.id, c.port.toString()));
        return map;
    });
    const editingRef = useRef<Set<string>>(new Set());
    const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    
    useEffect(() => {
        const interval = setInterval(() => {
            const current = getClients();
            if (current.length !== clients.length) {
                setClients(current);
                setPortInputs(prev => {
                    const newMap = new Map(prev);
                    current.forEach(c => {
                        if (!newMap.has(c.id)) {
                            newMap.set(c.id, c.port.toString());
                        }
                    });
                    return newMap;
                });
                return;
            }
            const hasExternalChange = current.some(c => {
                if (editingRef.current.has(c.id)) return false;
                const old = clients.find(oc => oc.id === c.id);
                if (!old) return false;
                return old.port !== c.port || old.enabled !== c.enabled;
            });
            if (hasExternalChange) {
                setClients(prevClients => 
                    prevClients.map(prevClient => {
                        if (editingRef.current.has(prevClient.id)) return prevClient;
                        const external = current.find(c => c.id === prevClient.id);
                        return external || prevClient;
                    })
                );
            }
        }, 2000);
        return () => clearInterval(interval);
    }, [clients, portInputs]);
    
    useEffect(() => {
        const statusInterval = setInterval(() => setStatusRefresh(prev => prev + 1), 1000);
        return () => clearInterval(statusInterval);
    }, []);

    const addClient = () => {
        const newClient: ClientConfig = {
            id: `client_${Date.now()}`,
            name: `Client ${clients.length + 1}`,
            port: 25580 + clients.length,
            channelId: "",
            enabled: true,
            forwardToDiscord: false,
        };
        const updated = [...clients, newClient];
        setPortInputs(prev => new Map(prev).set(newClient.id, newClient.port.toString()));
        saveClients(updated);
        setClients(updated);
    };

    const removeClient = (id: string) => {
        disconnectWebSocket(id);
        playerNames.delete(id);
        const updated = clients.filter(c => c.id !== id);
        setPortInputs(prev => { const newMap = new Map(prev); newMap.delete(id); return newMap; });
        saveClients(updated);
        setClients(updated);
    };

    const updateClient = (id: string, updates: Partial<ClientConfig>, immediate = false) => {
        const oldClient = clients.find(c => c.id === id);
        const updated = clients.map(c => c.id === id ? { ...c, ...updates } : c);
        setClients(updated);
        
        const isTextInput = updates.name !== undefined || updates.channelId !== undefined;
        if (!immediate && isTextInput) {
            const existingTimer = saveTimersRef.current.get(id);
            if (existingTimer) clearTimeout(existingTimer);
            const timer = setTimeout(() => { saveClients(updated); saveTimersRef.current.delete(id); }, 300);
            saveTimersRef.current.set(id, timer);
        } else {
            saveClients(updated);
        }
        
        const newClient = updated.find(c => c.id === id);
        if (!newClient) return;
        const portChanged = oldClient && oldClient.port !== newClient.port;
        const enabledChanged = oldClient && oldClient.enabled !== newClient.enabled;
        if (portChanged || (enabledChanged && !newClient.enabled)) disconnectWebSocket(id);
        if (newClient.enabled && (!wsConnections.has(id) || portChanged || enabledChanged)) {
            setTimeout(() => connectWebSocket(newClient), 100);
        }
    };

    return (
        <div style={{ padding: "16px", color: "#ffffff", maxHeight: "60vh", overflowY: "auto" }}>
            {/* Global Settings */}
            <div style={{ marginBottom: "16px", padding: "12px", backgroundColor: "#2b2d31", borderRadius: "8px", border: "1px solid #4f545c" }}>
                <div style={{ marginBottom: "10px", fontWeight: "600", color: "#fff" }}>Global Settings</div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#b5bac1", fontSize: "13px", cursor: "pointer" }}>
                        <input 
                            type="checkbox" 
                            checked={autoConnect} 
                            onChange={(e) => { 
                                setAutoConnect(e.target.checked); 
                                settings.store.autoConnect = e.target.checked; 
                            }} 
                            style={{ cursor: "pointer", width: "16px", height: "16px" }} 
                        />
                        Auto Connect on Discord startup
                    </label>
                </div>
                <div>
                    <label style={{ display: "block", marginBottom: "4px", color: "#b5bac1", fontSize: "12px" }}>Connection Logging Channel ID</label>
                    <input 
                        type="text" 
                        value={logChannel} 
                        onChange={(e) => setLogChannel(e.target.value)}
                        onBlur={(e) => { settings.store.connectionLoggingChannel = e.target.value; }}
                        placeholder="Enter channel ID for connection logs"
                        style={{ width: "100%", padding: "8px", color: "#fff", backgroundColor: "#1e1f22", border: "1px solid #4f545c", borderRadius: "4px", boxSizing: "border-box" }}
                    />
                </div>
            </div>
            
            {/* Client Management */}
            <div style={{ marginBottom: "12px" }}>
                <button 
                    onClick={addClient} 
                    style={{ padding: "8px 16px", color: "#fff", backgroundColor: "#3ba55c", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "500" }}
                >
                    + Add Client
                </button>
            </div>
            {clients.length === 0 && (
                <div style={{ textAlign: "center", padding: "20px", color: "#b5bac1", border: "1px dashed #4f545c", borderRadius: "8px" }}>
                    No clients configured. Click "Add Client" to get started.
                </div>
            )}
            {clients.map((client) => (
                <div key={client.id} style={{ border: "1px solid #4f545c", padding: "12px", marginBottom: "12px", borderRadius: "8px", backgroundColor: "#2b2d31" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <strong style={{ color: "#fff", fontSize: "14px" }}>{client.name}</strong>
                        <button onClick={() => removeClient(client.id)} style={{ padding: "4px 12px", color: "#fff", backgroundColor: "#ed4245", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}>Remove</button>
                    </div>
                    <div style={{ display: "grid", gap: "8px" }}>
                        <div>
                            <label style={{ display: "block", marginBottom: "4px", color: "#b5bac1", fontSize: "12px" }}>Name</label>
                            <input type="text" value={client.name}
                                onFocus={() => editingRef.current.add(client.id)}
                                onChange={(e) => setClients(clients.map(c => c.id === client.id ? { ...c, name: e.target.value } : c))}
                                onBlur={(e) => { editingRef.current.delete(client.id); updateClient(client.id, { name: e.target.value }, true); }}
                                style={{ width: "100%", padding: "8px", color: "#fff", backgroundColor: "#1e1f22", border: "1px solid #4f545c", borderRadius: "4px", boxSizing: "border-box" }}
                            />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                            <div>
                                <label style={{ display: "block", marginBottom: "4px", color: "#b5bac1", fontSize: "12px" }}>Port</label>
                                <input type="text" value={portInputs.get(client.id) ?? client.port.toString()}
                                    onChange={(e) => { if (e.target.value === "" || /^\d+$/.test(e.target.value)) setPortInputs(prev => new Map(prev).set(client.id, e.target.value)); }}
                                    onBlur={(e) => { const v = e.target.value === "" ? 0 : parseInt(e.target.value); updateClient(client.id, { port: isNaN(v) ? 0 : v }, true); setPortInputs(prev => new Map(prev).set(client.id, isNaN(v) ? "0" : v.toString())); }}
                                    style={{ width: "100%", padding: "8px", color: "#fff", backgroundColor: "#1e1f22", border: "1px solid #4f545c", borderRadius: "4px", boxSizing: "border-box" }}
                                />
                            </div>
                            <div>
                                <label style={{ display: "block", marginBottom: "4px", color: "#b5bac1", fontSize: "12px" }}>Channel ID</label>
                                <input type="text" value={client.channelId} placeholder="Enter channel ID"
                                    onFocus={() => editingRef.current.add(client.id)}
                                    onChange={(e) => setClients(clients.map(c => c.id === client.id ? { ...c, channelId: e.target.value } : c))}
                                    onBlur={(e) => { editingRef.current.delete(client.id); updateClient(client.id, { channelId: e.target.value }, true); }}
                                    style={{ width: "100%", padding: "8px", color: "#fff", backgroundColor: "#1e1f22", border: "1px solid #4f545c", borderRadius: "4px", boxSizing: "border-box" }}
                                />
                            </div>
                        </div>
                        <div style={{ display: "flex", gap: "16px", marginTop: "4px" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#b5bac1", fontSize: "13px", cursor: "pointer" }}>
                                <input type="checkbox" checked={client.enabled} onChange={(e) => updateClient(client.id, { enabled: e.target.checked })} style={{ cursor: "pointer", width: "16px", height: "16px" }} />
                                Enabled
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#b5bac1", fontSize: "13px", cursor: "pointer" }}>
                                <input type="checkbox" checked={client.forwardToDiscord ?? false} onChange={(e) => updateClient(client.id, { forwardToDiscord: e.target.checked })} style={{ cursor: "pointer", width: "16px", height: "16px" }} />
                                Forward to Discord
                            </label>
                        </div>
                        <div style={{ fontSize: "12px", color: "#b5bac1", marginTop: "4px" }}>
                            Status: <span style={{ 
                                color: (() => { const ws = wsConnections.get(client.id); if (!ws) return "#ed4245"; if (ws.readyState === WebSocket.OPEN) return "#3ba55c"; if (ws.readyState === WebSocket.CONNECTING) return "#faa61a"; return "#ed4245"; })(),
                                fontWeight: "500"
                            }}>
                                {(() => {
                                    const _ = statusRefresh;
                                    const ws = wsConnections.get(client.id);
                                    if (!ws) return "Disconnected";
                                    if (ws.readyState === WebSocket.CONNECTING) return "Connecting...";
                                    if (ws.readyState === WebSocket.CLOSING) return "Closing...";
                                    if (ws.readyState === WebSocket.OPEN) {
                                        const pn = playerNames.get(client.id);
                                        return pn ? `Connected (${pn})` : "Connected";
                                    }
                                    return "Disconnected";
                                })()}
                            </span>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

// Open the settings modal
function openSettingsModal() {
    openModal(props => (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>Minecraft Chat Settings</Text>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>
            <ModalContent>
                <SettingsModalContent onClose={props.onClose} />
            </ModalContent>
        </ModalRoot>
    ));
}

// Chat bar button component
const MinecraftChatButton: ChatBarButton = () => {
    // Check if current channel has any connected clients
    const [hasConnection, setHasConnection] = useState(false);
    
    useEffect(() => {
        const checkConnection = () => {
            const clients = getClients();
            const hasAnyConnection = clients.some(c => {
                const ws = wsConnections.get(c.id);
                return ws && ws.readyState === WebSocket.OPEN && c.enabled;
            });
            setHasConnection(hasAnyConnection);
        };
        
        checkConnection();
        const interval = setInterval(checkConnection, 2000);
        return () => clearInterval(interval);
    }, []);
    
    return (
        <ChatBarButton
            tooltip="Minecraft Chat Settings"
            onClick={openSettingsModal}
        >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ color: hasConnection ? "#3ba55c" : "currentColor" }}>
                <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "MinecraftChat",
    description: "Bridge Discord channel chat with multiple Minecraft clients via WebSocket",
    authors: [{ name: "Aurick", id: 1348025017233047634n }],
    settings,

    start() {
        log("Plugin starting...");

        // Add chat bar button
        addChatBarButton("MinecraftChat", MinecraftChatButton);

        // Subscribe to Discord message events (only once)
        if (!isSubscribed) {
            FluxDispatcher.subscribe("MESSAGE_CREATE", handleDiscordMessage);
            FluxDispatcher.subscribe("MESSAGE_SEND", handleMessageSend);
            isSubscribed = true;
        }

        // Connect to all enabled clients if auto-connect is enabled
        if (settings.store.autoConnect) {
            setTimeout(() => {
                const clients = getClients();
                for (const client of clients) {
                    if (client.enabled) {
                        connectWebSocket(client);
                    }
                }
            }, 2000);
        }

        log("Plugin started!");
    },

    stop() {
        log("Plugin stopping...");

        // Remove chat bar button
        removeChatBarButton("MinecraftChat");

        // Unsubscribe from Discord message events
        if (isSubscribed) {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleDiscordMessage);
            FluxDispatcher.unsubscribe("MESSAGE_SEND", handleMessageSend);
            isSubscribed = false;
        }

        // Clear tracked data
        sentMessageNonces.clear();
        processedDiscordMessageIds.clear();
        forwardedToDiscordMessages.clear();
        disconnectMessageSent.clear();

        // Disconnect all WebSockets
        disconnectAllWebSockets();

        log("Plugin stopped!");
    },

    // Settings panel component
    settingsAboutComponent: () => {
        const ClientsManager = () => {
            const [clients, setClients] = useState<ClientConfig[]>(getClients());
            const [statusRefresh, setStatusRefresh] = useState(0);
            // Local state for port inputs to allow empty values
            const [portInputs, setPortInputs] = useState<Map<string, string>>(() => {
                const map = new Map<string, string>();
                clients.forEach(c => map.set(c.id, c.port.toString()));
                return map;
            });
            
            // Track which clients are currently being edited to prevent overwriting
            const editingRef = useRef<Set<string>>(new Set());
            
            // Reload clients when settings change externally (but preserve local edits)
            useEffect(() => {
                const interval = setInterval(() => {
                    const current = getClients();
                    
                    // Only reload if there's a structural change (client added/removed)
                    // or if a client that's not being edited has changed
                    if (current.length !== clients.length) {
                        // Client added or removed - always reload
                        setClients(current);
                        setPortInputs(prev => {
                            const newMap = new Map(prev);
                            current.forEach(c => {
                                if (!newMap.has(c.id)) {
                                    newMap.set(c.id, c.port.toString());
                                }
                            });
                            return newMap;
                        });
                        return;
                    }
                    
                    // Check for changes in non-editing clients (port, enabled changes)
                    const hasExternalChange = current.some(c => {
                        if (editingRef.current.has(c.id)) return false;
                        const old = clients.find(oc => oc.id === c.id);
                        if (!old) return false;
                        return old.port !== c.port || old.enabled !== c.enabled;
                    });
                    
                    if (hasExternalChange) {
                        // Merge changes: keep local edits, apply external changes
                        setClients(prevClients => 
                            prevClients.map(prevClient => {
                                if (editingRef.current.has(prevClient.id)) {
                                    return prevClient;
                                }
                                const external = current.find(c => c.id === prevClient.id);
                                return external || prevClient;
                            })
                        );
                    }
                }, 2000);
                return () => clearInterval(interval);
            }, [clients, portInputs]);
            
            // Refresh status display every second to show real-time connection state
            useEffect(() => {
                const statusInterval = setInterval(() => {
                    setStatusRefresh(prev => prev + 1);
                }, 1000);
                return () => clearInterval(statusInterval);
            }, []);
        
            const addClient = () => {
            const newClient: ClientConfig = {
                id: `client_${Date.now()}`,
                name: `Client ${clients.length + 1}`,
                port: 25580 + clients.length,
                channelId: "",
                enabled: true,
                forwardToDiscord: false,
            };
                const updated = [...clients, newClient];
                setPortInputs(prev => new Map(prev).set(newClient.id, newClient.port.toString()));
                saveClients(updated);
                setClients(updated);
            };

            const removeClient = (id: string) => {
                disconnectWebSocket(id);
                playerNames.delete(id); // Clean up player name when removing client
                const updated = clients.filter(c => c.id !== id);
                setPortInputs(prev => {
                    const newMap = new Map(prev);
                    newMap.delete(id);
                    return newMap;
                });
                saveClients(updated);
                setClients(updated);
            };

            // Debounce timers for saving text inputs
            const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
            
            const updateClient = (id: string, updates: Partial<ClientConfig>, immediate = false) => {
                const oldClient = clients.find(c => c.id === id);
                const updated = clients.map(c => 
                    c.id === id ? { ...c, ...updates } : c
                );
                
                // Update state immediately for responsive UI
                setClients(updated);
                
                // Debounce save for text inputs to avoid focus issues
                const isTextInput = updates.name !== undefined || updates.channelId !== undefined;
                if (!immediate && isTextInput) {
                    // Clear existing timer
                    const existingTimer = saveTimersRef.current.get(id);
                    if (existingTimer) {
                        clearTimeout(existingTimer);
                    }
                    
                    // Set new timer to save after user stops typing
                    const timer = setTimeout(() => {
                        saveClients(updated);
                        saveTimersRef.current.delete(id);
                    }, 300);
                    saveTimersRef.current.set(id, timer);
                } else {
                    // Save immediately for checkboxes, port changes, etc.
                    saveClients(updated);
                }
                
                const newClient = updated.find(c => c.id === id);
                if (!newClient) return;
                
                const portChanged = oldClient && oldClient.port !== newClient.port;
                const enabledChanged = oldClient && oldClient.enabled !== newClient.enabled;
                
                if (portChanged || (enabledChanged && !newClient.enabled)) {
                    disconnectWebSocket(id);
                }
                
                if (newClient.enabled && (!wsConnections.has(id) || portChanged || enabledChanged)) {
                    setTimeout(() => connectWebSocket(newClient), 100);
                }
            };

            return (
                <div style={{ padding: "10px", color: "#ffffff" }}>
                    <style>{`
                        .no-spinner::-webkit-inner-spin-button,
                        .no-spinner::-webkit-outer-spin-button {
                            -webkit-appearance: none;
                            margin: 0;
                        }
                        .no-spinner {
                            -moz-appearance: textfield;
                        }
                    `}</style>
                    <div style={{ marginBottom: "10px" }}>
                    <button 
                        onClick={addClient} 
                        style={{ 
                            padding: "5px 10px", 
                            marginBottom: "10px",
                            color: "#ffffff",
                            backgroundColor: "var(--button-positive-background)",
                            border: "none",
                            borderRadius: "4px",
                            cursor: "pointer"
                        }}
                    >
                        Add Client
                    </button>
                </div>
                {clients.length === 0 && (
                    <div style={{ 
                        textAlign: "center", 
                        padding: "20px", 
                        color: "#ffffff",
                        border: "1px solid var(--background-modifier-accent)",
                        borderRadius: "4px",
                        marginBottom: "10px"
                    }}>
                        No clients configured. Click "Add Client" to get started.
                    </div>
                )}
                {clients.length > 0 && clients.map((client) => (
                    <div key={client.id} style={{ 
                        border: "1px solid var(--background-modifier-accent)", 
                        padding: "10px", 
                        marginBottom: "10px",
                        borderRadius: "4px",
                        color: "#ffffff"
                    }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                            <strong style={{ color: "#ffffff" }}>{client.name}</strong>
                            <button 
                                onClick={() => removeClient(client.id)} 
                                style={{ 
                                    padding: "2px 8px",
                                    color: "#ffffff",
                                    backgroundColor: "var(--button-danger-background)",
                                    border: "none",
                                    borderRadius: "4px",
                                    cursor: "pointer"
                                }}
                            >
                                Remove
                            </button>
                        </div>
                        <div style={{ marginBottom: "5px" }}>
                            <label style={{ display: "block", marginBottom: "2px", color: "#ffffff" }}>Name:</label>
                            <input
                                type="text"
                                value={client.name}
                                onFocus={() => {
                                    editingRef.current.add(client.id);
                                }}
                                onChange={(e) => {
                                    setClients(clients.map(c => 
                                        c.id === client.id ? { ...c, name: e.target.value } : c
                                    ));
                                }}
                                onBlur={(e) => {
                                    editingRef.current.delete(client.id);
                                    updateClient(client.id, { name: e.target.value }, true);
                                }}
                                style={{ 
                                    width: "100%", 
                                    padding: "4px",
                                    color: "#ffffff",
                                    backgroundColor: "var(--input-background)",
                                    border: "1px solid var(--input-border)",
                                    borderRadius: "4px"
                                }}
                            />
                        </div>
                        <div style={{ marginBottom: "5px" }}>
                            <label style={{ display: "block", marginBottom: "2px", color: "#ffffff" }}>Port:</label>
                            <input
                                type="text"
                                value={portInputs.get(client.id) ?? client.port.toString()}
                                onChange={(e) => {
                                    const inputValue = e.target.value;
                                    if (inputValue === "" || /^\d+$/.test(inputValue)) {
                                        setPortInputs(prev => {
                                            const newMap = new Map(prev);
                                            newMap.set(client.id, inputValue);
                                            return newMap;
                                        });
                                    }
                                }}
                                onBlur={(e) => {
                                    const inputValue = e.target.value;
                                    const portValue = inputValue === "" ? 0 : parseInt(inputValue);
                                    updateClient(client.id, { port: isNaN(portValue) ? 0 : portValue }, true);
                                    setPortInputs(prev => {
                                        const newMap = new Map(prev);
                                        newMap.set(client.id, isNaN(portValue) ? "0" : portValue.toString());
                                        return newMap;
                                    });
                                }}
                                onKeyDown={(e) => {
                                    const allowedKeys = [8, 9, 27, 13, 46];
                                    const ctrlKeys = [65, 67, 86, 88];
                                    const navKeys = e.keyCode >= 35 && e.keyCode <= 39;
                                    
                                    if (allowedKeys.includes(e.keyCode) || 
                                        (ctrlKeys.includes(e.keyCode) && e.ctrlKey) || 
                                        navKeys) {
                                        return;
                                    }
                                    
                                    if ((e.shiftKey || (e.keyCode < 48 || e.keyCode > 57)) && (e.keyCode < 96 || e.keyCode > 105)) {
                                        e.preventDefault();
                                    }
                                }}
                                style={{ 
                                    width: "100%", 
                                    padding: "4px",
                                    color: "#ffffff",
                                    backgroundColor: "var(--input-background)",
                                    border: "1px solid var(--input-border)",
                                    borderRadius: "4px"
                                }}
                            />
                        </div>
                        <div style={{ marginBottom: "5px" }}>
                            <label style={{ display: "block", marginBottom: "2px", color: "#ffffff" }}>Channel ID:</label>
                            <input
                                type="text"
                                value={client.channelId}
                                onFocus={() => {
                                    editingRef.current.add(client.id);
                                }}
                                onChange={(e) => {
                                    setClients(clients.map(c => 
                                        c.id === client.id ? { ...c, channelId: e.target.value } : c
                                    ));
                                }}
                                onBlur={(e) => {
                                    editingRef.current.delete(client.id);
                                    updateClient(client.id, { channelId: e.target.value }, true);
                                }}
                                style={{ 
                                    width: "100%", 
                                    padding: "4px",
                                    color: "#ffffff",
                                    backgroundColor: "var(--input-background)",
                                    border: "1px solid var(--input-border)",
                                    borderRadius: "4px"
                                }}
                                placeholder="Discord Channel ID"
                            />
                        </div>
                        <div style={{ marginBottom: "5px" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "5px", color: "#ffffff" }}>
                                <input
                                    type="checkbox"
                                    checked={client.enabled}
                                    onChange={(e) => updateClient(client.id, { enabled: e.target.checked })}
                                    style={{ cursor: "pointer" }}
                                />
                                <span style={{ color: "#ffffff" }}>Enabled</span>
                            </label>
                        </div>
                        <div style={{ marginBottom: "5px" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "5px", color: "#ffffff" }}>
                                <input
                                    type="checkbox"
                                    checked={client.forwardToDiscord ?? false}
                                    onChange={(e) => updateClient(client.id, { forwardToDiscord: e.target.checked })}
                                    style={{ cursor: "pointer" }}
                                />
                                <span style={{ color: "#ffffff" }}>Forward to Discord</span>
                            </label>
                        </div>
                        <div style={{ fontSize: "12px", color: "#ffffff" }}>
                            Status: <span style={{ 
                                color: (() => {
                                    const ws = wsConnections.get(client.id);
                                    if (!ws) return "#f87171";
                                    const state = ws.readyState;
                                    if (state === WebSocket.OPEN) return "#4ade80";
                                    if (state === WebSocket.CONNECTING) return "#fbbf24";
                                    return "#f87171";
                                })()
                            }}>
                                {(() => {
                                    const _ = statusRefresh;
                                    const ws = wsConnections.get(client.id);
                                    if (!ws) {
                                        return "Disconnected";
                                    }
                                    const state = ws.readyState;
                                    if (state === WebSocket.CONNECTING) return "Connecting...";
                                    if (state === WebSocket.CLOSING) return "Closing...";
                                    if (state === WebSocket.OPEN) {
                                        const playerName = playerNames.get(client.id);
                                        return playerName ? `Connected (${playerName})` : "Connected";
                                    }
                                    return "Disconnected";
                                })()}
                            </span>
                        </div>
                    </div>
                ))}
                </div>
            );
        };
        
        return <ClientsManager />;
    },

    // Expose functions for manual control
    toolboxActions: {
        "Connect All Clients": () => {
            const clients = getClients();
            for (const client of clients) {
                if (client.enabled) {
                    connectWebSocket(client);
                }
            }
        },
        "Disconnect All Clients": () => {
            disconnectAllWebSockets();
        },
        "Check Connection Status": () => {
            const clients = getClients();
            log(`${clients.length} client(s) configured`);
            for (const client of clients) {
                const ws = wsConnections.get(client.id);
                const status = ws?.readyState;
                const statusText =
                    status === WebSocket.CONNECTING ? "Connecting" :
                    status === WebSocket.OPEN ? "Connected" :
                    status === WebSocket.CLOSING ? "Closing" :
                    "Disconnected";
                log(`${client.name} (port ${client.port}, channel ${client.channelId}): ${statusText}`);
            }
        },
    },
});
