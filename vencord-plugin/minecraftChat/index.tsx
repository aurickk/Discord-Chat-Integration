import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, useState, useEffect, useRef } from "@webpack/common";

// Client configuration interface
interface ClientConfig {
    id: string;
    name: string;
    port: number;
    channelId: string;
    enabled: boolean;
}

// WebSocket connections - Map of client ID to WebSocket
const wsConnections = new Map<string, WebSocket>();
const reconnectIntervals = new Map<string, ReturnType<typeof setInterval>>();
const isConnecting = new Map<string, boolean>();

// Track processed messages to prevent duplicates
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUP_WINDOW = 5000; // 5 seconds window for duplicate detection

// Track if we're already subscribed to prevent multiple subscriptions
let isSubscribed = false;

const settings = definePluginSettings({
    autoConnect: {
        type: OptionType.BOOLEAN,
        description: "Automatically connect to all enabled clients on Discord startup",
        default: true,
        restartNeeded: false,
    },
    showConnectionMessages: {
        type: OptionType.BOOLEAN,
        description: "Show connection status messages in console",
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
    if (settings.store.showConnectionMessages) {
        console.log(`[MinecraftChat] ${message}`, ...args);
    }
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
        console.log("[MinecraftChat] Saved clients:", clients.length, "client(s)");
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
            
            // If we used a different port due to conflict, update the client config and notify
            if (portToUse !== client.port) {
                const clients = getClients();
                const updated = clients.map(c => 
                    c.id === client.id ? { ...c, port: portToUse } : c
                );
                saveClients(updated);
                console.warn(`[MinecraftChat] Port ${client.port} was taken for "${client.name}". Using port ${portToUse} instead.`);
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
                handleMinecraftMessage(data, client);
            } catch (e) {
                log(`Error parsing message from ${client.name}:`, e);
            }
        };

        ws.onclose = (event) => {
            isConnecting.set(client.id, false);
            
            // If connection was refused (port in use) and we haven't tried alternative ports, try next port
            if (event.code === 1006 && portToUse === client.port) {
                // Connection refused - port might be in use
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
            // Error handling is done in onclose, this is just for logging
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
}

function disconnectAllWebSockets() {
    for (const clientId of wsConnections.keys()) {
        disconnectWebSocket(clientId);
    }
}

function handleMinecraftMessage(data: any, client: ClientConfig) {
    if (data.type === "connection_status") {
        log(`Minecraft mod (${client.name}): ${data.message}`);
    } else if (data.type === "pong") {
        log(`Received pong from ${client.name}`);
    }
}

function sendToMinecraft(author: string, content: string, channelId: string) {
    // Find the client that handles this channel
    const clients = getClients();
    const client = clients.find(c => c.channelId === channelId && c.enabled);
    
    if (!client) {
        return;
    }

    const ws = wsConnections.get(client.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    const message = {
        type: "discord_message",
        author: author,
        content: content,
    };

    try {
        ws.send(JSON.stringify(message));
        if (settings.store.showConnectionMessages) {
            log(`Sent to Minecraft (${client.name}): ${author}: ${content}`);
        }
    } catch (e) {
        console.error(`[MinecraftChat] Error sending message to ${client.name}:`, e);
    }
}

function handleDiscordMessage(event: any) {
    if (!event.message) {
        return;
    }

    const message = event.message;
    const channelId = message.channel_id;

    // Find which client handles this channel
    const clients = getClients();
    const client = clients.find(c => c.channelId === channelId && c.enabled);
    
    if (!client) {
        return;
    }

    // Prevent duplicate processing
    const messageId = message.id;
    const timestamp = message.timestamp || (message.edited_timestamp ? new Date(message.edited_timestamp).getTime() : Date.now());
    const content = message.content || "";
    
    const authorId = message.author?.id || "unknown";
    const dedupKey = messageId 
        ? `id:${messageId}` 
        : `content:${timestamp}_${authorId}_${content.substring(0, 100).replace(/\s+/g, ' ')}`;
    
    const now = Date.now();
    const lastProcessed = processedMessages.get(dedupKey);
    
    if (lastProcessed && (now - lastProcessed) < MESSAGE_DEDUP_WINDOW) {
        return;
    }
    
    processedMessages.set(dedupKey, now);
    
    // Clean up old entries periodically
    if (processedMessages.size > 100 && processedMessages.size % 10 === 0) {
        for (const [key, time] of processedMessages.entries()) {
            if (now - time > MESSAGE_DEDUP_WINDOW) {
                processedMessages.delete(key);
            }
        }
    }

    // Get the message content
    if (!content) {
        return;
    }

    // Get author name
    const authorName = message.author?.username || "Unknown";

    // Forward message to the appropriate Minecraft client
    sendToMinecraft(authorName, content, channelId);
}

export default definePlugin({
    name: "MinecraftChat",
    description: "Bridge Discord channel chat with multiple Minecraft clients via WebSocket",
    authors: [{ name: "Aurick", id: 1348025017233047634n }],
    settings,

    start() {
        log("Plugin starting...");

        // Subscribe to Discord message events (only once)
        if (!isSubscribed) {
            FluxDispatcher.subscribe("MESSAGE_CREATE", handleDiscordMessage);
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

        // Unsubscribe from Discord message events
        if (isSubscribed) {
            FluxDispatcher.unsubscribe("MESSAGE_CREATE", handleDiscordMessage);
            isSubscribed = false;
        }

        // Clear processed messages
        processedMessages.clear();

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
            
            // Reload clients when settings change (less frequent to avoid input focus issues)
            useEffect(() => {
                const interval = setInterval(() => {
                    const current = getClients();
                    const currentJson = JSON.stringify(current);
                    const clientsJson = JSON.stringify(clients);
                    // Only update if actually different (avoid unnecessary re-renders)
                    if (currentJson !== clientsJson) {
                        setClients(current);
                        // Update port inputs map when clients change externally
                        const newPortInputs = new Map<string, string>();
                        current.forEach(c => {
                            if (!portInputs.has(c.id)) {
                                newPortInputs.set(c.id, c.port.toString());
                            } else {
                                newPortInputs.set(c.id, portInputs.get(c.id)!);
                            }
                        });
                        setPortInputs(newPortInputs);
                    }
                }, 2000); // Check every 2 seconds instead of 500ms
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
            };
                const updated = [...clients, newClient];
                // Initialize port input state for new client
                setPortInputs(prev => {
                    const newMap = new Map(prev);
                    newMap.set(newClient.id, newClient.port.toString());
                    return newMap;
                });
                saveClients(updated);
                setClients(updated);
            };

            const removeClient = (id: string) => {
                disconnectWebSocket(id);
                const updated = clients.filter(c => c.id !== id);
                // Remove port input state for deleted client
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
                if (newClient) {
                    // Check if port or channelId changed (these require reconnection)
                    const portChanged = oldClient && oldClient.port !== newClient.port;
                    const channelIdChanged = oldClient && oldClient.channelId !== newClient.channelId;
                    const enabledChanged = oldClient && oldClient.enabled !== newClient.enabled;
                    
                    // If port changed or client was disabled, disconnect old connection
                    if (portChanged || enabledChanged && !newClient.enabled) {
                        disconnectWebSocket(id);
                    }
                    
                    // If client is enabled and (not connected, port changed, or was just enabled), connect
                    if (newClient.enabled) {
                        if (!wsConnections.has(id) || portChanged || (enabledChanged && newClient.enabled)) {
                            // Small delay to ensure old connection is closed
                            setTimeout(() => {
                                connectWebSocket(newClient);
                            }, 100);
                        }
                    } else if (enabledChanged && !newClient.enabled) {
                        disconnectWebSocket(id);
                    }
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
                                onChange={(e) => {
                                    // Update state immediately for UI responsiveness
                                    const updated = clients.map(c => 
                                        c.id === client.id ? { ...c, name: e.target.value } : c
                                    );
                                    setClients(updated);
                                }}
                                onBlur={(e) => {
                                    // Save when user leaves the field
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
                                    // Only allow numeric input or empty string
                                    const inputValue = e.target.value;
                                    // Allow empty string or numbers only
                                    if (inputValue === "" || /^\d+$/.test(inputValue)) {
                                        // Update local port input state only (don't update client.port yet)
                                        setPortInputs(prev => {
                                            const newMap = new Map(prev);
                                            newMap.set(client.id, inputValue);
                                            return newMap;
                                        });
                                    }
                                    // If input doesn't match pattern, ignore it (don't update)
                                }}
                                onBlur={(e) => {
                                    // Save the port value when user leaves the field
                                    const inputValue = e.target.value;
                                    const portValue = inputValue === "" ? 0 : parseInt(inputValue);
                                    // Update the actual client port
                                    updateClient(client.id, { port: isNaN(portValue) ? 0 : portValue }, true);
                                    // Update port input to match saved value
                                    setPortInputs(prev => {
                                        const newMap = new Map(prev);
                                        newMap.set(client.id, isNaN(portValue) ? "0" : portValue.toString());
                                        return newMap;
                                    });
                                }}
                                onKeyDown={(e) => {
                                    // Allow: backspace, delete, tab, escape, enter, and numbers
                                    if ([8, 9, 27, 13, 46].indexOf(e.keyCode) !== -1 ||
                                        // Allow: Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
                                        (e.keyCode === 65 && e.ctrlKey === true) ||
                                        (e.keyCode === 67 && e.ctrlKey === true) ||
                                        (e.keyCode === 86 && e.ctrlKey === true) ||
                                        (e.keyCode === 88 && e.ctrlKey === true) ||
                                        // Allow: home, end, left, right
                                        (e.keyCode >= 35 && e.keyCode <= 39)) {
                                        return;
                                    }
                                    // Ensure that it is a number and stop the keypress
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
                                onChange={(e) => {
                                    // Update state immediately for UI responsiveness
                                    const updated = clients.map(c => 
                                        c.id === client.id ? { ...c, channelId: e.target.value } : c
                                    );
                                    setClients(updated);
                                }}
                                onBlur={(e) => {
                                    // Save when user leaves the field
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
                                    // Use statusRefresh to force re-evaluation
                                    const _ = statusRefresh;
                                    const ws = wsConnections.get(client.id);
                                    if (!ws) return "Disconnected";
                                    const state = ws.readyState;
                                    if (state === WebSocket.CONNECTING) return "Connecting...";
                                    if (state === WebSocket.OPEN) return "Connected";
                                    if (state === WebSocket.CLOSING) return "Closing...";
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
            console.log(`[MinecraftChat] ${clients.length} client(s) configured`);
            for (const client of clients) {
                const ws = wsConnections.get(client.id);
                const status = ws?.readyState;
                const statusText =
                    status === WebSocket.CONNECTING ? "Connecting" :
                    status === WebSocket.OPEN ? "Connected" :
                    status === WebSocket.CLOSING ? "Closing" :
                    "Disconnected";
                console.log(`[MinecraftChat] ${client.name} (port ${client.port}, channel ${client.channelId}): ${statusText}`);
            }
        },
    },
});
