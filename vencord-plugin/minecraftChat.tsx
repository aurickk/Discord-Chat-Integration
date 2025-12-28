import { definePluginSettings } from "@api/Settings";
import { addChatBarButton, removeChatBarButton, ChatBarButton } from "@api/ChatButtons";
import { openModal, ModalRoot, ModalHeader, ModalContent, ModalCloseButton, ModalSize } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, useState, useEffect, useRef, UserStore } from "@webpack/common";
import { ChannelStore, RestAPI, Constants, Text } from "@webpack/common";

interface ClientConfig {
    id: string;
    name: string;
    port: number;
    channelId: string;
    enabled: boolean;
    forwardToDiscord?: boolean;
    syncGroup?: "none" | "A" | "B" | "C" | "D" | "E" | "F";
}

interface DelayedMessage {
    author: string;
    content: string;
    channelId: string;
    messageId?: string;
}

interface AutomationAction {
    type: "message" | "enable_delay" | "disable_delay" | "wait" | "discord_message";
    content?: string;
    waitTime?: number;
    targetClientIds?: string[];
}

interface AutomationConfig {
    id: string;
    name: string;
    enabled: boolean;
    clientIds: string[];
    trigger: string;
    isAbsolute: boolean;
    actions: AutomationAction[];
    cooldown: number;
}

const automationLastTriggered = new Map<string, number>();
const wsConnections = new Map<string, WebSocket>();
const reconnectIntervals = new Map<string, ReturnType<typeof setInterval>>();
const isConnecting = new Map<string, boolean>();
const playerNames = new Map<string, string>();
const disconnectMessageSent = new Map<string, boolean>();
const sentMessageNonces = new Set<string>();
const forwardedToDiscordMessages = new Set<string>();
const processedDiscordMessageIds = new Set<string>();
const messageQueues = new Map<string, Array<{ plainText: string; messageText: string; channelId: string; clientName: string }>>();
const isSendingMessage = new Map<string, boolean>();

let chatDelayEnabled = false;
const delayedMessages: DelayedMessage[] = [];
const clientTicks = new Map<string, number>();
const TICK_SYNC_BUFFER = 5;
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
    advancedFeatures: {
        type: OptionType.BOOLEAN,
        description: "Enable advanced features: Chat Delay, Sync Groups, and Automations",
        default: false,
        restartNeeded: false,
    },
    clientProperties: {
        type: OptionType.STRING,
        description: "Stores client information, do not edit.",
        default: "[]",
        restartNeeded: false,
    },
    automationProperties: {
        type: OptionType.STRING,
        description: "Stores automation configurations, do not edit.",
        default: "[]",
        restartNeeded: false,
    },
});

function log(message: string, ...args: any[]) {
    if (settings.store.enableConsoleLogging) {
        console.log(`[MinecraftChat] ${message}`, ...args);
    }
}

async function sendLogToDiscord(content: string) {
    const logChannelId = settings.store.connectionLoggingChannel;
    if (!logChannelId) return;
    
    try {
        const channel = ChannelStore.getChannel(logChannelId);
        if (!channel) return;
        
        const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
        sentMessageNonces.add(nonce);
        
        await RestAPI.post({
            url: Constants.Endpoints.MESSAGES(channel.id),
            body: { content, flags: 0, mobile_network_type: "unknown", nonce, tts: false }
        });
    } catch (e) {
        console.error(`[MinecraftChat] Error sending log:`, e);
    }
}

function getConnectedClientsList(): string {
    const clients = getClients();
    const connected = clients.filter(c => {
        const ws = wsConnections.get(c.id);
        return ws && ws.readyState === WebSocket.OPEN;
    });
    
    if (connected.length === 0) return "None";
    
    return connected.map(c => {
        const name = playerNames.get(c.id);
        return name ? `• ${c.name} (${name})` : `• ${c.name}`;
    }).join("\n");
}

function getClients(): ClientConfig[] {
    try {
        return JSON.parse(settings.store.clientProperties || "[]");
    } catch (e) {
        console.error("[MinecraftChat] Error parsing clients:", e);
        return [];
    }
}

function saveClients(clients: ClientConfig[]) {
    try {
        settings.store.clientProperties = JSON.stringify(clients);
    } catch (e) {
        console.error("[MinecraftChat] Error saving clients:", e);
    }
}

function getAutomations(): AutomationConfig[] {
    try {
        return JSON.parse(settings.store.automationProperties || "[]");
    } catch (e) {
        console.error("[MinecraftChat] Error parsing automations:", e);
        return [];
    }
}

function saveAutomations(automations: AutomationConfig[]) {
    try {
        settings.store.automationProperties = JSON.stringify(automations);
    } catch (e) {
        console.error("[MinecraftChat] Error saving automations:", e);
    }
}

async function executeAutomationActions(automation: AutomationConfig, triggeringClientId: string) {
    const clients = getClients();
    log(`Executing ${automation.actions.length} action(s) for automation "${automation.name}"`);
    
    for (const action of automation.actions) {
        switch (action.type) {
            case "message":
                if (action.content?.trim()) {
                    const targetIds = action.targetClientIds?.length ? action.targetClientIds : automation.clientIds;
                    const targets = clients.filter(c => targetIds.includes(c.id) && c.enabled);
                    
                    for (const client of targets) {
                        const ws = wsConnections.get(client.id);
                        if (ws?.readyState === WebSocket.OPEN) {
                            try {
                                ws.send(JSON.stringify({
                                    type: "discord_message",
                                    author: "Automation",
                                    content: action.content,
                                    tickSync: false,
                                }));
                            } catch (e) {
                                console.error(`[MinecraftChat] Error sending to ${client.name}:`, e);
                            }
                        }
                    }
                }
                break;
                
            case "enable_delay":
                if (!chatDelayEnabled) chatDelayEnabled = true;
                break;
                
            case "disable_delay":
                if (chatDelayEnabled) {
                    chatDelayEnabled = false;
                    if (delayedMessages.length > 0) flushDelayedMessages();
                }
                break;
                
            case "wait":
                if (action.waitTime && action.waitTime > 0) {
                    await new Promise(resolve => setTimeout(resolve, action.waitTime));
                }
                break;
                
            case "discord_message":
                if (action.content?.trim()) {
                    await sendLogToDiscord(action.content);
                }
                break;
        }
    }
}

function checkAutomations(messageContent: string, clientId: string) {
    const automations = getAutomations();
    const trimmedContent = messageContent.trim();
    
    for (const automation of automations) {
        if (!automation.enabled) continue;
        if (!automation.clientIds.includes(clientId)) continue;
        
        const lastTriggered = automationLastTriggered.get(automation.id) || 0;
        const now = Date.now();
        if (now - lastTriggered < automation.cooldown) continue;
        
        const trigger = automation.trigger?.trim();
        if (!trigger) continue;
        
        const matches = automation.isAbsolute 
            ? trimmedContent === trigger 
            : trimmedContent.includes(trigger);
        
        if (matches) {
            log(`Automation "${automation.name}" triggered`);
            automationLastTriggered.set(automation.id, now);
            executeAutomationActions(automation, clientId);
        }
    }
}

function connectWebSocket(client: ClientConfig, attemptedPort?: number): void {
    const existingWs = wsConnections.get(client.id);
    if (existingWs?.readyState === WebSocket.OPEN || isConnecting.get(client.id)) return;

    isConnecting.set(client.id, true);
    const portToUse = attemptedPort ?? client.port;

    try {
        const ws = new WebSocket(`ws://127.0.0.1:${portToUse}`);
        wsConnections.set(client.id, ws);

        ws.onopen = () => {
            isConnecting.set(client.id, false);
            
            if (portToUse !== client.port) {
                const clients = getClients();
                const updated = clients.map(c => c.id === client.id ? { ...c, port: portToUse } : c);
                saveClients(updated);
                log(`Port ${client.port} taken, using ${portToUse} for "${client.name}"`);
            }
            
            log(`Client "${client.name}" connected on port ${portToUse}`);
            
            try {
                ws.send(JSON.stringify({ type: "set_sync_group", syncGroup: client.syncGroup || "A" }));
            } catch (e) {}
            
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
            
            if (event.code === 1006 && portToUse === client.port) {
                const clients = getClients();
                const usedPorts = new Set(clients.filter(c => c.id !== client.id).map(c => c.port));
                
                let alternativePort = client.port + 1;
                let attempts = 0;
                while (attempts < 10 && (usedPorts.has(alternativePort) || alternativePort > 65535)) {
                    alternativePort++;
                    attempts++;
                }
                
                if (attempts < 10 && alternativePort <= 65535) {
                    setTimeout(() => connectWebSocket(client, alternativePort), 1000);
                    return;
                }
            }
            
            log(`Client "${client.name}" disconnected`);
            
            if (!disconnectMessageSent.get(client.id)) {
                disconnectMessageSent.set(client.id, true);
                sendLogToDiscord(`❌ **Client Disconnected**\n**Client:** ${client.name}\n\n**Connected Clients:**\n${getConnectedClientsList()}`);
            }

            if (settings.store.autoConnect && client.enabled && !reconnectIntervals.has(client.id)) {
                const interval = setInterval(() => {
                    const currentWs = wsConnections.get(client.id);
                    if (!currentWs || currentWs.readyState === WebSocket.CLOSED) {
                        const clients = getClients();
                        const updatedClient = clients.find(c => c.id === client.id);
                        if (updatedClient?.enabled) {
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

        ws.onerror = () => {};
    } catch (e) {
        isConnecting.set(client.id, false);
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
    disconnectMessageSent.delete(clientId);
}

function disconnectAllWebSockets() {
    for (const clientId of wsConnections.keys()) {
        disconnectWebSocket(clientId);
    }
}

function getChannelName(channelId: string): string | null {
    if (!channelId?.trim()) return null;
    try {
        const channel = ChannelStore.getChannel(channelId);
        return channel?.name || null;
    } catch (e) {
        return null;
    }
}

function refreshClientStatus(clientId: string) {
    const clients = getClients();
    const client = clients.find(c => c.id === clientId);
    if (!client) return;
    
    const ws = wsConnections.get(clientId);
    
    if (ws?.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify({ type: "request_player_info" }));
        } catch (e) {}
    } else {
        disconnectWebSocket(clientId);
        if (client.enabled) connectWebSocket(client);
    }
    
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("minecraft-status-update"));
    }
}

function hasMultipleClientsForChannel(channelId: string): boolean {
    const clients = getClients();
    return clients.filter(c => c.channelId === channelId && c.enabled && c.forwardToDiscord).length > 1;
}

function handleMinecraftMessage(data: any, clientId: string) {
    const clients = getClients();
    const client = clients.find(c => c.id === clientId);
    if (!client) return;
    
    if (data.type === "connection_status") {
        const newPlayerName = data.playerName;
        const isValid = newPlayerName && newPlayerName !== "Unknown" && newPlayerName.trim() !== "";
        
        if (isValid) {
            const previousPlayerName = playerNames.get(clientId);
            const isNewOrReconnect = disconnectMessageSent.get(clientId) === true || !playerNames.has(clientId);
            
            playerNames.set(clientId, newPlayerName);
            
            if (isNewOrReconnect || previousPlayerName !== newPlayerName) {
                disconnectMessageSent.set(clientId, false);
                sendLogToDiscord(`✅ **Client Connected**\n**Client:** ${client.name}\n**Player:** ${newPlayerName}\n\n**Connected Clients:**\n${getConnectedClientsList()}`);
            }
        }
    } else if (data.type === "player_info") {
        const newPlayerName = data.name;
        if (newPlayerName && newPlayerName !== "Unknown") {
            playerNames.set(clientId, newPlayerName);
            if (typeof window !== "undefined") {
                window.dispatchEvent(new CustomEvent("minecraft-status-update"));
            }
        }
    } else if (data.type === "tick_update") {
        if (typeof data.tick === "number" && data.tick >= 0) {
            clientTicks.set(clientId, data.tick);
        }
    } else if (data.type === "minecraft_message") {
        const author = data.author || "Minecraft";
        const content = data.content || "";
        if (!content) return;
        
        checkAutomations(content, clientId);
        
        const freshClients = getClients();
        const freshClient = freshClients.find(c => c.id === clientId);
        if (!freshClient) return;
        
        if (!freshClient.forwardToDiscord || !freshClient.channelId) return;
        
        const playerName = playerNames.get(clientId);
        if (playerName) {
            const isOwnMessage = content.startsWith(`<${playerName}>`) ||
                (author !== "System" && author !== "Minecraft" && author === playerName);
            if (isOwnMessage) return;
        }
        
        let plainText = (author !== "System" && author !== "Minecraft") 
            ? `${author}: ${content}` : content;
        
        if (hasMultipleClientsForChannel(freshClient.channelId)) {
            plainText = `[${freshClient.name}] ${plainText}`;
        }
        
        const messageText = plainText.includes("\n") 
            ? `\`\`\`\n${plainText}\n\`\`\`` 
            : `\`${plainText}\``;
        
        if (!messageQueues.has(clientId)) {
            messageQueues.set(clientId, []);
        }
        messageQueues.get(clientId)!.push({ plainText, messageText, channelId: freshClient.channelId, clientName: freshClient.name });
        processMessageQueue(clientId);
    }
}

async function processMessageQueue(clientId: string) {
    if (isSendingMessage.get(clientId)) return;
    
    const queue = messageQueues.get(clientId);
    if (!queue?.length) return;
    
    isSendingMessage.set(clientId, true);
    
    while (queue.length > 0) {
        const message = queue.shift()!;
        
        try {
            const channel = ChannelStore.getChannel(message.channelId);
            if (!channel) continue;
            
            const messageKey = `${message.channelId}:${message.plainText}`;
            forwardedToDiscordMessages.add(messageKey);
            
            if (forwardedToDiscordMessages.size > 100) {
                const entries = Array.from(forwardedToDiscordMessages);
                forwardedToDiscordMessages.clear();
                entries.slice(-50).forEach(key => forwardedToDiscordMessages.add(key));
            }
            
            setTimeout(() => forwardedToDiscordMessages.delete(messageKey), 5000);
            
            const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            sentMessageNonces.add(nonce);
            
            await RestAPI.post({
                url: Constants.Endpoints.MESSAGES(channel.id),
                body: { content: message.messageText, flags: 0, mobile_network_type: "unknown", nonce, tts: false }
            });
        } catch (e) {
            console.error(`[MinecraftChat] Error sending to Discord:`, e);
        }
    }
    
    isSendingMessage.set(clientId, false);
}

function sendToMinecraft(author: string, content: string, channelId: string, messageId?: string) {
    const clients = getClients();
    const matchingClients = clients.filter(c => c.channelId === channelId && c.enabled);
    if (matchingClients.length === 0) return;

    const clientsBySyncGroup = new Map<string, ClientConfig[]>();
    for (const client of matchingClients) {
        const syncGroup = client.syncGroup || "A";
        if (!clientsBySyncGroup.has(syncGroup)) {
            clientsBySyncGroup.set(syncGroup, []);
        }
        clientsBySyncGroup.get(syncGroup)!.push(client);
    }
    
    const syncGroupTargetTicks = new Map<string, number>();
    for (const [syncGroup, groupClients] of clientsBySyncGroup) {
        if (syncGroup !== "none" && groupClients.length >= 2) {
            const targetTick = calculateTargetTickForSyncGroup(syncGroup);
            if (targetTick >= 0) {
                syncGroupTargetTicks.set(syncGroup, targetTick);
            }
        }
    }

    for (const client of matchingClients) {
        const ws = wsConnections.get(client.id);
        if (ws?.readyState === WebSocket.OPEN) {
            try {
                const syncGroup = client.syncGroup || "A";
                const targetTick = syncGroupTargetTicks.get(syncGroup);
                const useTickSync = targetTick !== undefined && targetTick >= 0;
                
                const message: any = {
                    type: "discord_message",
                    author, content,
                    tickSync: useTickSync,
                    syncGroup,
                };
                if (useTickSync) message.targetTick = targetTick;
                if (messageId) message.messageId = messageId;
                
                ws.send(JSON.stringify(message));
            } catch (e) {
                console.error(`[MinecraftChat] Error sending to ${client.name}:`, e);
            }
        }
    }
}

function isChatDelayEnabled(): boolean {
    return chatDelayEnabled;
}

function getDelayedMessageCount(): number {
    return delayedMessages.length;
}

function toggleChatDelay(): boolean {
    chatDelayEnabled = !chatDelayEnabled;
    if (!chatDelayEnabled && delayedMessages.length > 0) {
        flushDelayedMessages();
    }
    log(`Chat delay ${chatDelayEnabled ? "enabled" : "disabled"}`);
    return chatDelayEnabled;
}

function calculateTargetTickForSyncGroup(syncGroup: string): number {
    if (syncGroup === "none") return -1;
    
    const clients = getClients();
    const syncGroupClients = clients.filter(c => c.enabled && (c.syncGroup || "A") === syncGroup);
    if (syncGroupClients.length === 0) return -1;
    
    let maxTick = -1;
    for (const client of syncGroupClients) {
        const tick = clientTicks.get(client.id);
        if (tick !== undefined && tick >= 0) {
            maxTick = Math.max(maxTick, tick);
        }
    }
    
    if (maxTick < 0) {
        log(`No tick data for sync group ${syncGroup}`);
        return -1;
    }
    
    return maxTick + TICK_SYNC_BUFFER;
}

function flushDelayedMessages() {
    if (delayedMessages.length === 0) return;
    
    log(`Flushing ${delayedMessages.length} delayed message(s)`);
    const syncGroupTargetTicks = new Map<string, number>();
    
    while (delayedMessages.length > 0) {
        const msg = delayedMessages.shift()!;
        sendToMinecraftWithSyncGroups(msg.author, msg.content, msg.channelId, msg.messageId, syncGroupTargetTicks);
    }
}

function sendToMinecraftWithSyncGroups(
    author: string, 
    content: string, 
    channelId: string, 
    messageId?: string,
    syncGroupTargetTicks?: Map<string, number>
) {
    const clients = getClients();
    const matchingClients = clients.filter(c => c.channelId === channelId && c.enabled);
    
    if (matchingClients.length === 0) return;
    
    const clientsBySyncGroup = new Map<string, ClientConfig[]>();
    for (const client of matchingClients) {
        const group = client.syncGroup || "A";
        if (!clientsBySyncGroup.has(group)) {
            clientsBySyncGroup.set(group, []);
        }
        clientsBySyncGroup.get(group)!.push(client);
    }
    
    for (const [syncGroup, groupClients] of clientsBySyncGroup) {
        let targetTick: number;
        if (syncGroupTargetTicks && syncGroupTargetTicks.has(syncGroup)) {
            targetTick = syncGroupTargetTicks.get(syncGroup)!;
        } else {
            targetTick = calculateTargetTickForSyncGroup(syncGroup);
            if (syncGroupTargetTicks) {
                syncGroupTargetTicks.set(syncGroup, targetTick);
            }
        }
        
        for (const client of groupClients) {
            const ws = wsConnections.get(client.id);
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    const message: any = {
                        type: "discord_message",
                        author: author,
                        content: content,
                        tickSync: targetTick >= 0,
                        syncGroup: syncGroup,
                    };
                    if (messageId) message.messageId = messageId;
                    if (targetTick >= 0) message.targetTick = targetTick;
                    ws.send(JSON.stringify(message));
                } catch (e) {
                    console.error(`[MinecraftChat] Error sending message to ${client.name}:`, e);
                }
            }
        }
    }
}

function queueDelayedMessage(author: string, content: string, channelId: string, messageId?: string) {
    delayedMessages.push({ author, content, channelId, messageId });
    log(`Message queued (${delayedMessages.length} in queue)`);
}

function clearDelayedMessages() {
    const count = delayedMessages.length;
    delayedMessages.length = 0;
    log(`Cleared ${count} delayed message(s)`);
}

function handleMessageSend(event: any) {
    if (event.nonce) {
        sentMessageNonces.add(event.nonce);
        if (sentMessageNonces.size > 1000) {
            const noncesArray = Array.from(sentMessageNonces);
            sentMessageNonces.clear();
            noncesArray.slice(-500).forEach(nonce => sentMessageNonces.add(nonce));
        }
    }
}

function handleDiscordMessage(event: any) {
    if (!event.message) return;

    const message = event.message;
    const channelId = message.channel_id;
    const messageId = message.id;

    if (messageId && processedDiscordMessageIds.has(messageId)) return;

    const clients = getClients();
    const matchingClients = clients.filter(c => c.channelId === channelId && c.enabled);
    if (matchingClients.length === 0) return;
    
    if (messageId) {
        processedDiscordMessageIds.add(messageId);
        if (processedDiscordMessageIds.size > 1000) {
            const idsArray = Array.from(processedDiscordMessageIds);
            processedDiscordMessageIds.clear();
            idsArray.slice(-500).forEach(id => processedDiscordMessageIds.add(id));
        }
    }
    
    if (message.nonce && sentMessageNonces.has(message.nonce)) {
        sentMessageNonces.delete(message.nonce);
        return;
    }
    
    const currentUserId = UserStore.getCurrentUser()?.id;
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
        if (forwardedToDiscordMessages.has(messageKey)) {
            forwardedToDiscordMessages.delete(messageKey);
            return;
        }
    }

    if (!messageContent) return;

    const authorName = message.author?.username || "Unknown";

    if (chatDelayEnabled) {
        queueDelayedMessage(authorName, messageContent, channelId, messageId);
        return;
    }

    sendToMinecraft(authorName, messageContent, channelId, messageId);
}

// Settings modal content - reuses the ClientsManager component
function SettingsModalContent({ onClose }: { onClose: () => void }) {
    const [clients, setClients] = useState<ClientConfig[]>(getClients());
    const [statusRefresh, setStatusRefresh] = useState(0);
    const [autoConnect, setAutoConnect] = useState(settings.store.autoConnect);
    const [logChannel, setLogChannel] = useState(settings.store.connectionLoggingChannel || "");
    const [advancedFeatures, setAdvancedFeatures] = useState(settings.store.advancedFeatures);
    const [chatDelay, setChatDelay] = useState(chatDelayEnabled);
    const [delayedCount, setDelayedCount] = useState(delayedMessages.length);
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
        const statusInterval = setInterval(() => {
            setStatusRefresh(prev => prev + 1);
            // Sync state with settings and global variables
            setChatDelay(chatDelayEnabled);
            setDelayedCount(delayedMessages.length);
            // Sync advanced features toggle with settings
            if (advancedFeatures !== settings.store.advancedFeatures) {
                setAdvancedFeatures(settings.store.advancedFeatures);
            }
        }, 1000);
        return () => clearInterval(statusInterval);
    }, [advancedFeatures]);

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
        const syncGroupChanged = oldClient && (oldClient.syncGroup || "A") !== (newClient.syncGroup || "A");
        
        // Send sync group update if it changed and client is connected
        if (syncGroupChanged && newClient.enabled) {
            const ws = wsConnections.get(id);
            if (ws && ws.readyState === WebSocket.OPEN) {
                try {
                    const syncGroup = newClient.syncGroup || "A";
                    ws.send(JSON.stringify({
                        type: "set_sync_group",
                        syncGroup: syncGroup
                    }));
                    log(`Updated sync group to "${syncGroup}" for ${newClient.name}`);
                } catch (e) {
                    log(`Error updating sync group for ${newClient.name}:`, e);
                }
            }
        }
        
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
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#b5bac1", fontSize: "13px", cursor: "pointer" }}>
                        <input 
                            type="checkbox" 
                            checked={advancedFeatures} 
                            onChange={(e) => { 
                                setAdvancedFeatures(e.target.checked); 
                                settings.store.advancedFeatures = e.target.checked; 
                            }} 
                            style={{ cursor: "pointer", width: "16px", height: "16px" }} 
                        />
                        Advanced Features (Chat Delay, Sync Groups, Automations)
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
            
            {/* Chat Delay Section - Advanced Feature */}
            {advancedFeatures && (
                <div style={{ 
                    marginBottom: "16px", 
                    padding: "12px", 
                    backgroundColor: chatDelay ? "#3ba55c20" : "#2b2d31", 
                    borderRadius: "8px", 
                    border: `1px solid ${chatDelay ? "#3ba55c" : "#4f545c"}` 
                }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <div style={{ fontWeight: "600", color: "#fff" }}>Chat Delay</div>
                        {chatDelay && (
                            <span style={{ fontSize: "12px", color: "#faa61a", fontWeight: "500" }}>
                                {delayedCount} message{delayedCount !== 1 ? "s" : ""} queued
                            </span>
                        )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                        <button 
                            onClick={() => {
                                const newState = toggleChatDelay();
                                setChatDelay(newState);
                                setDelayedCount(delayedMessages.length);
                            }} 
                            style={{ 
                                padding: "8px 16px", 
                                color: "#fff", 
                                backgroundColor: chatDelay ? "#ed4245" : "#3ba55c", 
                                border: "none", 
                                borderRadius: "4px", 
                                cursor: "pointer", 
                                fontWeight: "500",
                                minWidth: "140px"
                            }}
                        >
                            {chatDelay ? "Disable & Send" : "Enable Delay"}
                        </button>
                        {chatDelay && delayedCount > 0 && (
                            <button 
                                onClick={() => {
                                    clearDelayedMessages();
                                    setDelayedCount(0);
                                }} 
                                style={{ 
                                    padding: "8px 16px", 
                                    color: "#fff", 
                                    backgroundColor: "#4f545c", 
                                    border: "none", 
                                    borderRadius: "4px", 
                                    cursor: "pointer", 
                                    fontWeight: "500"
                                }}
                            >
                                Clear Queue
                            </button>
                        )}
                    </div>
                    <div style={{ fontSize: "12px", color: "#b5bac1" }}>
                        {chatDelay 
                            ? "Messages are being queued. Disable to send all at the same game tick."
                            : "Enable to queue messages for tick-perfect execution across multiple clients."
                        }
                    </div>
                </div>
            )}
            
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
                                <label style={{ display: "block", marginBottom: "4px", color: "#b5bac1", fontSize: "12px" }}>
                                    Channel ID
                                    {(() => {
                                        const channelName = getChannelName(client.channelId);
                                        return channelName ? ` (${channelName})` : "";
                                    })()}
                                </label>
                                <input type="text" value={client.channelId} placeholder="Enter channel ID"
                                    onFocus={() => editingRef.current.add(client.id)}
                                    onChange={(e) => setClients(clients.map(c => c.id === client.id ? { ...c, channelId: e.target.value } : c))}
                                    onBlur={(e) => { editingRef.current.delete(client.id); updateClient(client.id, { channelId: e.target.value }, true); }}
                                    style={{ width: "100%", padding: "8px", color: "#fff", backgroundColor: "#1e1f22", border: "1px solid #4f545c", borderRadius: "4px", boxSizing: "border-box" }}
                                />
                            </div>
                        </div>
                        <div style={{ display: "flex", gap: "16px", marginTop: "4px", flexWrap: "wrap", alignItems: "center" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#b5bac1", fontSize: "13px", cursor: "pointer" }}>
                                <input type="checkbox" checked={client.enabled} onChange={(e) => updateClient(client.id, { enabled: e.target.checked })} style={{ cursor: "pointer", width: "16px", height: "16px" }} />
                                Enabled
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#b5bac1", fontSize: "13px", cursor: "pointer" }}>
                                <input type="checkbox" checked={client.forwardToDiscord ?? false} onChange={(e) => updateClient(client.id, { forwardToDiscord: e.target.checked })} style={{ cursor: "pointer", width: "16px", height: "16px" }} />
                                Forward to Discord
                            </label>
                            {advancedFeatures && (
                                <label style={{ display: "flex", alignItems: "center", gap: "6px", color: "#b5bac1", fontSize: "13px" }}>
                                    Sync Group:
                                    <select 
                                        value={client.syncGroup || "A"} 
                                        onChange={(e) => updateClient(client.id, { syncGroup: e.target.value as ClientConfig["syncGroup"] }, true)}
                                        style={{ 
                                            padding: "4px 8px", 
                                            color: "#fff", 
                                            backgroundColor: "#1e1f22", 
                                            border: "1px solid #4f545c", 
                                            borderRadius: "4px", 
                                            cursor: "pointer",
                                            fontSize: "13px"
                                        }}
                                    >
                                        <option value="none">None</option>
                                        <option value="A">A</option>
                                        <option value="B">B</option>
                                        <option value="C">C</option>
                                        <option value="D">D</option>
                                        <option value="E">E</option>
                                        <option value="F">F</option>
                                    </select>
                                </label>
                            )}
                        </div>
                        <div style={{ fontSize: "12px", color: "#b5bac1", marginTop: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
                            <span>
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
                            </span>
                            <button
                                onClick={() => {
                                    refreshClientStatus(client.id);
                                    setStatusRefresh(prev => prev + 1);
                                }}
                                style={{
                                    padding: "2px 8px",
                                    fontSize: "11px",
                                    color: "#fff",
                                    backgroundColor: "#4f545c",
                                    border: "none",
                                    borderRadius: "3px",
                                    cursor: "pointer"
                                }}
                                title="Refresh connection status and player name"
                            >
                                ↻ Refresh
                            </button>
                        </div>
                    </div>
                </div>
            ))}
            
            {/* Automations Section - Advanced Feature */}
            {advancedFeatures && (
                <div style={{ marginTop: "24px", borderTop: "1px solid #4f545c", paddingTop: "16px" }}>
                    <div style={{ marginBottom: "12px", fontWeight: "600", color: "#fff", fontSize: "16px" }}>Automations</div>
                    <AutomationsManager clients={clients} />
                </div>
            )}
        </div>
    );
}

// Automations Manager Component
function AutomationsManager({ clients }: { clients: ClientConfig[] }) {
    const [automations, setAutomations] = useState<AutomationConfig[]>(getAutomations());
    
    useEffect(() => {
        // Sync with storage periodically
        const interval = setInterval(() => {
            const current = getAutomations();
            if (JSON.stringify(current) !== JSON.stringify(automations)) {
                setAutomations(current);
            }
        }, 2000);
        return () => clearInterval(interval);
    }, [automations]);

    const addAutomation = () => {
        const newAutomation: AutomationConfig = {
            id: `automation_${Date.now()}`,
            name: `Automation ${automations.length + 1}`,
            enabled: true,
            clientIds: [],
            trigger: "",
            isAbsolute: false,
            actions: [],
            cooldown: 1000,
        };
        const updated = [...automations, newAutomation];
        saveAutomations(updated);
        setAutomations(updated);
    };

    const removeAutomation = (id: string) => {
        const updated = automations.filter(a => a.id !== id);
        automationLastTriggered.delete(id);
        saveAutomations(updated);
        setAutomations(updated);
    };

    const updateAutomation = (id: string, updates: Partial<AutomationConfig>) => {
        const updated = automations.map(a => a.id === id ? { ...a, ...updates } : a);
        saveAutomations(updated);
        setAutomations(updated);
    };

    const addAction = (automationId: string, actionType: AutomationAction["type"]) => {
        const automation = automations.find(a => a.id === automationId);
        if (!automation) return;
        
        const newAction: AutomationAction = {
            type: actionType,
            content: (actionType === "message" || actionType === "discord_message") ? "" : undefined,
            waitTime: actionType === "wait" ? 1000 : undefined,
        };
        
        updateAutomation(automationId, {
            actions: [...automation.actions, newAction]
        });
    };

    const updateAction = (automationId: string, actionIndex: number, updates: Partial<AutomationAction>) => {
        const automation = automations.find(a => a.id === automationId);
        if (!automation) return;
        
        const updatedActions = automation.actions.map((action, idx) => 
            idx === actionIndex ? { ...action, ...updates } : action
        );
        
        updateAutomation(automationId, { actions: updatedActions });
    };

    const removeAction = (automationId: string, actionIndex: number) => {
        const automation = automations.find(a => a.id === automationId);
        if (!automation) return;
        
        const updatedActions = automation.actions.filter((_, idx) => idx !== actionIndex);
        updateAutomation(automationId, { actions: updatedActions });
    };

    const moveAction = (automationId: string, actionIndex: number, direction: "up" | "down") => {
        const automation = automations.find(a => a.id === automationId);
        if (!automation) return;
        
        const newIndex = direction === "up" ? actionIndex - 1 : actionIndex + 1;
        if (newIndex < 0 || newIndex >= automation.actions.length) return;
        
        const updatedActions = [...automation.actions];
        const [movedAction] = updatedActions.splice(actionIndex, 1);
        updatedActions.splice(newIndex, 0, movedAction);
        
        updateAutomation(automationId, { actions: updatedActions });
    };

    const toggleClient = (automationId: string, clientId: string) => {
        const automation = automations.find(a => a.id === automationId);
        if (!automation) return;
        
        const clientIds = automation.clientIds.includes(clientId)
            ? automation.clientIds.filter(id => id !== clientId)
            : [...automation.clientIds, clientId];
        
        updateAutomation(automationId, { clientIds });
    };

    return (
        <div>
            <div style={{ marginBottom: "12px" }}>
                <button 
                    onClick={addAutomation} 
                    style={{ padding: "8px 16px", color: "#fff", backgroundColor: "#5865f2", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "500" }}
                >
                    + Add Automation
                </button>
            </div>
            
            {automations.length === 0 && (
                <div style={{ textAlign: "center", padding: "20px", color: "#b5bac1", border: "1px dashed #4f545c", borderRadius: "8px" }}>
                    No automations configured. Click "Add Automation" to create one.
                </div>
            )}
            
            {automations.map((automation) => (
                <div key={automation.id} style={{ border: "1px solid #4f545c", padding: "12px", marginBottom: "12px", borderRadius: "8px", backgroundColor: "#2b2d31" }}>
                    {/* Header with name and remove button */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                                <input 
                                    type="checkbox" 
                                    checked={automation.enabled} 
                                    onChange={(e) => updateAutomation(automation.id, { enabled: e.target.checked })} 
                                    style={{ cursor: "pointer", width: "16px", height: "16px" }} 
                                />
                            </label>
                            <input 
                                type="text" 
                                value={automation.name}
                                onChange={(e) => updateAutomation(automation.id, { name: e.target.value })}
                                style={{ 
                                    padding: "6px 10px", 
                                    color: "#fff", 
                                    backgroundColor: "#1e1f22", 
                                    border: "1px solid #4f545c", 
                                    borderRadius: "4px",
                                    fontWeight: "600",
                                    fontSize: "14px",
                                    width: "200px"
                                }}
                            />
                        </div>
                        <button 
                            onClick={() => removeAutomation(automation.id)} 
                            style={{ padding: "4px 12px", color: "#fff", backgroundColor: "#ed4245", border: "none", borderRadius: "4px", cursor: "pointer", fontSize: "12px" }}
                        >
                            Remove
                        </button>
                    </div>
                    
                    {/* Client Selection */}
                    <div style={{ marginBottom: "10px" }}>
                        <label style={{ display: "block", marginBottom: "6px", color: "#b5bac1", fontSize: "12px" }}>Listen to Clients:</label>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                            {clients.length === 0 ? (
                                <span style={{ color: "#72767d", fontSize: "12px", fontStyle: "italic" }}>No clients configured</span>
                            ) : (
                                clients.map(client => (
                                    <label 
                                        key={client.id} 
                                        style={{ 
                                            display: "flex", 
                                            alignItems: "center", 
                                            gap: "6px", 
                                            padding: "4px 8px",
                                            backgroundColor: automation.clientIds.includes(client.id) ? "#5865f220" : "#1e1f22",
                                            border: `1px solid ${automation.clientIds.includes(client.id) ? "#5865f2" : "#4f545c"}`,
                                            borderRadius: "4px",
                                            cursor: "pointer",
                                            fontSize: "12px",
                                            color: "#b5bac1"
                                        }}
                                    >
                                        <input 
                                            type="checkbox" 
                                            checked={automation.clientIds.includes(client.id)}
                                            onChange={() => toggleClient(automation.id, client.id)}
                                            style={{ cursor: "pointer" }}
                                        />
                                        {client.name}
                                    </label>
                                ))
                            )}
                        </div>
                    </div>
                    
                    {/* Trigger Configuration */}
                    <div style={{ marginBottom: "10px" }}>
                        <label style={{ display: "block", marginBottom: "6px", color: "#b5bac1", fontSize: "12px" }}>Trigger:</label>
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                            <input 
                                type="text" 
                                value={automation.trigger}
                                onChange={(e) => updateAutomation(automation.id, { trigger: e.target.value })}
                                placeholder="Enter trigger text..."
                                style={{ 
                                    flex: 1,
                                    padding: "8px", 
                                    color: "#fff", 
                                    backgroundColor: "#1e1f22", 
                                    border: "1px solid #4f545c", 
                                    borderRadius: "4px",
                                    boxSizing: "border-box"
                                }}
                            />
                            <label style={{ 
                                display: "flex", 
                                alignItems: "center", 
                                gap: "6px", 
                                color: "#b5bac1", 
                                fontSize: "13px", 
                                cursor: "pointer",
                                whiteSpace: "nowrap"
                            }}>
                                <input 
                                    type="checkbox" 
                                    checked={automation.isAbsolute}
                                    onChange={(e) => updateAutomation(automation.id, { isAbsolute: e.target.checked })}
                                    style={{ cursor: "pointer", width: "16px", height: "16px" }}
                                />
                                Absolute Match
                            </label>
                        </div>
                        <div style={{ fontSize: "11px", color: "#72767d", marginTop: "4px" }}>
                            {automation.isAbsolute 
                                ? "Message must exactly match the trigger text"
                                : "Message must contain the trigger text"
                            }
                        </div>
                    </div>
                    
                    {/* Actions */}
                    <div style={{ marginBottom: "10px" }}>
                        <label style={{ display: "block", marginBottom: "6px", color: "#b5bac1", fontSize: "12px" }}>Actions:</label>
                        
                        {automation.actions.length === 0 && (
                            <div style={{ padding: "10px", backgroundColor: "#1e1f22", borderRadius: "4px", color: "#72767d", fontSize: "12px", marginBottom: "8px" }}>
                                No actions configured. Add an action below.
                            </div>
                        )}
                        
                        {automation.actions.map((action, actionIndex) => (
                            <div 
                                key={actionIndex} 
                                style={{ 
                                    display: "flex", 
                                    gap: "8px", 
                                    alignItems: "center", 
                                    marginBottom: "8px",
                                    padding: "8px",
                                    backgroundColor: "#1e1f22",
                                    borderRadius: "4px"
                                }}
                            >
                                <span style={{ 
                                    color: "#72767d", 
                                    fontSize: "12px",
                                    minWidth: "20px"
                                }}>
                                    {actionIndex + 1}.
                                </span>
                                
                                {action.type === "message" ? (
                                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "6px" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                            <span style={{ color: "#3ba55c", fontSize: "12px", minWidth: "70px" }}>Minecraft:</span>
                                            <input 
                                                type="text"
                                                value={action.content || ""}
                                                onChange={(e) => updateAction(automation.id, actionIndex, { content: e.target.value })}
                                                placeholder="Enter message or command..."
                                                style={{
                                                    flex: 1,
                                                    padding: "6px 8px",
                                                    color: "#fff",
                                                    backgroundColor: "#2b2d31",
                                                    border: "1px solid #4f545c",
                                                    borderRadius: "4px",
                                                    fontSize: "13px"
                                                }}
                                            />
                                        </div>
                                        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                                            <span style={{ color: "#72767d", fontSize: "11px" }}>Send to:</span>
                                            {clients.map(client => {
                                                const isSelected = action.targetClientIds && action.targetClientIds.length > 0
                                                    ? action.targetClientIds.includes(client.id)
                                                    : automation.clientIds.includes(client.id);
                                                const isDefault = !action.targetClientIds || action.targetClientIds.length === 0;
                                                return (
                                                    <label key={client.id} style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: "4px",
                                                        padding: "2px 6px",
                                                        backgroundColor: isSelected ? "#3ba55c20" : "#2b2d31",
                                                        border: `1px solid ${isSelected ? "#3ba55c" : "#4f545c"}`,
                                                        borderRadius: "4px",
                                                        cursor: "pointer",
                                                        fontSize: "11px",
                                                        color: "#b5bac1",
                                                        opacity: isDefault ? 0.7 : 1
                                                    }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={(e) => {
                                                                const currentTargets = action.targetClientIds && action.targetClientIds.length > 0 
                                                                    ? [...action.targetClientIds]
                                                                    : [...automation.clientIds];
                                                                const newTargets = e.target.checked
                                                                    ? [...currentTargets, client.id]
                                                                    : currentTargets.filter(id => id !== client.id);
                                                                updateAction(automation.id, actionIndex, { targetClientIds: newTargets });
                                                            }}
                                                            style={{ cursor: "pointer", width: "12px", height: "12px" }}
                                                        />
                                                        {client.name}
                                                    </label>
                                                );
                                            })}
                                            {(!action.targetClientIds || action.targetClientIds.length === 0) && (
                                                <span style={{ fontSize: "10px", color: "#72767d", fontStyle: "italic" }}>(using trigger clients)</span>
                                            )}
                                        </div>
                                    </div>
                                ) : action.type === "enable_delay" ? (
                                    <span style={{ color: "#3ba55c", fontSize: "13px" }}>Enable Chat Delay</span>
                                ) : action.type === "disable_delay" ? (
                                    <span style={{ color: "#faa61a", fontSize: "13px" }}>Disable Chat Delay (& Send Queue)</span>
                                ) : action.type === "wait" ? (
                                    <>
                                        <span style={{ color: "#72767d", fontSize: "12px", minWidth: "50px" }}>Wait:</span>
                                        <input 
                                            type="number"
                                            value={action.waitTime || 0}
                                            onChange={(e) => updateAction(automation.id, actionIndex, { waitTime: Math.max(0, parseInt(e.target.value) || 0) })}
                                            min="0"
                                            placeholder="ms"
                                            style={{
                                                width: "100px",
                                                padding: "6px 8px",
                                                color: "#fff",
                                                backgroundColor: "#2b2d31",
                                                border: "1px solid #4f545c",
                                                borderRadius: "4px",
                                                fontSize: "13px"
                                            }}
                                        />
                                        <span style={{ color: "#72767d", fontSize: "12px" }}>ms</span>
                                    </>
                                ) : action.type === "discord_message" ? (
                                    <>
                                        <span style={{ color: "#5865f2", fontSize: "12px", minWidth: "80px" }}>Discord:</span>
                                        <input 
                                            type="text"
                                            value={action.content || ""}
                                            onChange={(e) => updateAction(automation.id, actionIndex, { content: e.target.value })}
                                            placeholder="Message to send to logging channel..."
                                            style={{
                                                flex: 1,
                                                padding: "6px 8px",
                                                color: "#fff",
                                                backgroundColor: "#2b2d31",
                                                border: "1px solid #4f545c",
                                                borderRadius: "4px",
                                                fontSize: "13px"
                                            }}
                                        />
                                    </>
                                ) : null}
                                
                                {/* Reorder buttons */}
                                <div style={{ display: "flex", gap: "2px", marginLeft: "auto" }}>
                                    <button
                                        onClick={() => moveAction(automation.id, actionIndex, "up")}
                                        disabled={actionIndex === 0}
                                        style={{
                                            padding: "4px 6px",
                                            color: actionIndex === 0 ? "#4f545c" : "#b5bac1",
                                            backgroundColor: "transparent",
                                            border: "1px solid #4f545c",
                                            borderRadius: "4px",
                                            cursor: actionIndex === 0 ? "not-allowed" : "pointer",
                                            fontSize: "10px"
                                        }}
                                        title="Move up"
                                    >
                                        ▲
                                    </button>
                                    <button
                                        onClick={() => moveAction(automation.id, actionIndex, "down")}
                                        disabled={actionIndex === automation.actions.length - 1}
                                        style={{
                                            padding: "4px 6px",
                                            color: actionIndex === automation.actions.length - 1 ? "#4f545c" : "#b5bac1",
                                            backgroundColor: "transparent",
                                            border: "1px solid #4f545c",
                                            borderRadius: "4px",
                                            cursor: actionIndex === automation.actions.length - 1 ? "not-allowed" : "pointer",
                                            fontSize: "10px"
                                        }}
                                        title="Move down"
                                    >
                                        ▼
                                    </button>
                                </div>
                                
                                <button
                                    onClick={() => removeAction(automation.id, actionIndex)}
                                    style={{
                                        padding: "4px 8px",
                                        color: "#ed4245",
                                        backgroundColor: "transparent",
                                        border: "1px solid #ed4245",
                                        borderRadius: "4px",
                                        cursor: "pointer",
                                        fontSize: "11px"
                                    }}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                        
                        {/* Add Action Dropdown */}
                        <div style={{ display: "flex", gap: "8px" }}>
                            <select
                                id={`action-type-${automation.id}`}
                                defaultValue="message"
                                style={{
                                    padding: "6px 10px",
                                    color: "#fff",
                                    backgroundColor: "#1e1f22",
                                    border: "1px solid #4f545c",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    fontSize: "12px"
                                }}
                            >
                                <option value="message">Send to Minecraft</option>
                                <option value="discord_message">Send to Discord</option>
                                <option value="wait">Wait</option>
                                <option value="enable_delay">Enable Chat Delay</option>
                                <option value="disable_delay">Disable Chat Delay</option>
                            </select>
                            <button
                                onClick={() => {
                                    const select = document.getElementById(`action-type-${automation.id}`) as HTMLSelectElement;
                                    const actionType = select?.value as AutomationAction["type"] || "message";
                                    addAction(automation.id, actionType);
                                }}
                                style={{
                                    padding: "6px 12px",
                                    color: "#fff",
                                    backgroundColor: "#4f545c",
                                    border: "none",
                                    borderRadius: "4px",
                                    cursor: "pointer",
                                    fontSize: "12px"
                                }}
                            >
                                + Add Action
                            </button>
                        </div>
                    </div>
                    
                    {/* Timing Settings */}
                    <div>
                        <label style={{ display: "block", marginBottom: "4px", color: "#b5bac1", fontSize: "12px" }}>
                            Cooldown (ms)
                        </label>
                        <input 
                            type="number"
                            value={automation.cooldown}
                            onChange={(e) => updateAutomation(automation.id, { cooldown: Math.max(0, parseInt(e.target.value) || 0) })}
                            min="0"
                            style={{
                                width: "200px",
                                padding: "8px",
                                color: "#fff",
                                backgroundColor: "#1e1f22",
                                border: "1px solid #4f545c",
                                borderRadius: "4px",
                                boxSizing: "border-box"
                            }}
                        />
                        <div style={{ fontSize: "11px", color: "#72767d", marginTop: "2px" }}>
                            Time before automation can trigger again
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
    const [isDelayActive, setIsDelayActive] = useState(chatDelayEnabled);
    const [queueCount, setQueueCount] = useState(delayedMessages.length);
    
    useEffect(() => {
        const checkStatus = () => {
            const clients = getClients();
            const hasAnyConnection = clients.some(c => {
                const ws = wsConnections.get(c.id);
                return ws && ws.readyState === WebSocket.OPEN && c.enabled;
            });
            setHasConnection(hasAnyConnection);
            setIsDelayActive(chatDelayEnabled);
            setQueueCount(delayedMessages.length);
        };
        
        checkStatus();
        const interval = setInterval(checkStatus, 500);
        return () => clearInterval(interval);
    }, []);
    
    // Determine button color: orange when delay active, green when connected, default otherwise
    const buttonColor = isDelayActive ? "#faa61a" : (hasConnection ? "#3ba55c" : "currentColor");
    const tooltipText = isDelayActive 
        ? `Chat Delay Active (${queueCount} queued) - Click to manage`
        : "Minecraft Chat Settings";
    
    return (
        <ChatBarButton
            tooltip={tooltipText}
            onClick={openSettingsModal}
        >
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ color: buttonColor }}>
                    <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                </svg>
                {isDelayActive && (
                    <div style={{
                        position: "absolute",
                        top: "-2px",
                        right: "-2px",
                        width: "8px",
                        height: "8px",
                        backgroundColor: "#faa61a",
                        borderRadius: "50%",
                        border: "2px solid var(--background-primary)"
                    }} />
                )}
            </div>
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

    // Settings panel component - minimal status with gear icon to open settings
    settingsAboutComponent: () => {
        const [hasConnection, setHasConnection] = useState(false);
        const [clientCount, setClientCount] = useState(0);
        
        useEffect(() => {
            const checkStatus = () => {
                const clients = getClients();
                setClientCount(clients.length);
                const hasAnyConnection = clients.some(c => {
                    const ws = wsConnections.get(c.id);
                    return ws && ws.readyState === WebSocket.OPEN && c.enabled;
                });
                setHasConnection(hasAnyConnection);
            };
            
            checkStatus();
            const interval = setInterval(checkStatus, 1000);
            return () => clearInterval(interval);
        }, []);
        
        return (
            <div style={{ padding: "16px", color: "#ffffff" }}>
                {/* Status Display with Gear Icon */}
                <div style={{ 
                    padding: "12px", 
                    backgroundColor: hasConnection ? "#3ba55c20" : "#ed424520",
                    borderRadius: "8px", 
                    border: `1px solid ${hasConnection ? "#3ba55c" : "#ed4245"}`,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center"
                }}>
                    <div>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                            <div style={{ 
                                width: "10px", 
                                height: "10px", 
                                borderRadius: "50%", 
                                backgroundColor: hasConnection ? "#3ba55c" : "#ed4245" 
                            }} />
                            <span style={{ fontWeight: "600" }}>
                                {hasConnection ? "Connected" : "Disconnected"}
                            </span>
                        </div>
                        <div style={{ fontSize: "13px", color: "#b5bac1" }}>
                            {clientCount} client{clientCount !== 1 ? "s" : ""} configured
                        </div>
                    </div>
                    {/* Gear Icon Button */}
                    <button
                        onClick={() => openSettingsModal()}
                        style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: "8px",
                            borderRadius: "4px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.1)"}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = "transparent"}
                        title="Open Client Settings"
                    >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ color: "#b5bac1" }}>
                            <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                        </svg>
                    </button>
                </div>
            </div>
        );
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

