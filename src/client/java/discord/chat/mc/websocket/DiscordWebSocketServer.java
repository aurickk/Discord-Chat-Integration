package discord.chat.mc.websocket;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import discord.chat.mc.DiscordChatIntegration;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public class DiscordWebSocketServer extends WebSocketServer {
    private static final Gson GSON = new Gson();
    private static DiscordWebSocketServer instance;
    
    private final Set<WebSocket> connections = Collections.synchronizedSet(new HashSet<>());
    private Consumer<ChatMessage> messageHandler;
    private boolean running = false;
    
    // Thread pool for processing incoming messages asynchronously
    private final ExecutorService messageExecutor = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "Discord-WebSocket-Message-Processor");
        t.setDaemon(true);
        return t;
    });
    
    public DiscordWebSocketServer(int port) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.setReuseAddr(true);
    }
    
    public static DiscordWebSocketServer getInstance() {
        return instance;
    }
    
    public static void createInstance(int port) {
        if (instance != null && instance.running) {
            instance.stopServer();
        }
        instance = new DiscordWebSocketServer(port);
    }
    
    public void setMessageHandler(Consumer<ChatMessage> handler) {
        this.messageHandler = handler;
    }
    
    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        connections.add(conn);
        DiscordChatIntegration.LOGGER.info("Discord client connected from: {}", conn.getRemoteSocketAddress());
        
        // Send connection confirmation with player name if available
        JsonObject response = new JsonObject();
        response.addProperty("type", "connection_status");
        response.addProperty("status", "connected");
        response.addProperty("message", "Connected to Minecraft Discord Chat Integration");
        
        // Try to get player name using multiple methods for cross-version compatibility
        String playerName = getPlayerName();
        if (playerName != null) {
            response.addProperty("playerName", playerName);
        }
        conn.send(GSON.toJson(response));
        
        // Schedule a follow-up to send player name once player loads in
        // This handles cases where connection happens before player is fully loaded
        Minecraft client = Minecraft.getInstance();
        if (client != null) {
            new Thread(() -> {
                try {
                    // Wait for player to load
                    for (int i = 0; i < 15; i++) {
                        Thread.sleep(1000);
                        String name = getPlayerName();
                        if (name != null && conn.isOpen()) {
                            JsonObject update = new JsonObject();
                            update.addProperty("type", "connection_status");
                            update.addProperty("status", "connected");
                            update.addProperty("message", "Player name update");
                            update.addProperty("playerName", name);
                            conn.send(GSON.toJson(update));
                            DiscordChatIntegration.LOGGER.info("Sent player name update: {}", name);
                            break;
                        }
                    }
                } catch (Exception e) {
                    DiscordChatIntegration.LOGGER.debug("Player name resolver error: {}", e.getMessage());
                }
            }, "PlayerName-Resolver").start();
        }
        
        // Show connection notification in chat when first client connects
        if (connections.size() == 1) {
            showConnectionNotification(true);
        }
    }
    
    /**
     * Get player name using multiple methods for cross-version compatibility.
     * Tries different approaches that may work in different Minecraft versions.
     */
    private String getPlayerName() {
        try {
            Minecraft client = Minecraft.getInstance();
            if (client == null) return null;
            
            // Method 1: Try player.getName().getString() (works in most versions)
            if (client.player != null) {
                try {
                    String name = client.player.getName().getString();
                    if (name != null && !name.isEmpty() && !name.equals("Player")) {
                        return name;
                    }
                } catch (Exception e) {
                    DiscordChatIntegration.LOGGER.debug("Method 1 failed: {}", e.getMessage());
                }
            }
            
            // Method 2: Try player.getGameProfile().getName() (game profile method)
            if (client.player != null) {
                try {
                    String name = client.player.getGameProfile().getName();
                    if (name != null && !name.isEmpty() && !name.equals("Player")) {
                        return name;
                    }
                } catch (Exception e) {
                    DiscordChatIntegration.LOGGER.debug("Method 2 failed: {}", e.getMessage());
                }
            }
            
            // Method 3: Try getUser().getName() (Session/User method for newer versions)
            try {
                if (client.getUser() != null) {
                    String name = client.getUser().getName();
                    if (name != null && !name.isEmpty() && !name.equals("Player")) {
                        return name;
                    }
                }
            } catch (Exception e) {
                DiscordChatIntegration.LOGGER.debug("Method 3 failed: {}", e.getMessage());
            }
            
            // Method 4: Try getting from game profile ID (fallback)
            try {
                if (client.getUser() != null && client.getUser().getProfileId() != null) {
                    // If we have a profile ID but no name, log it for debugging
                    DiscordChatIntegration.LOGGER.debug("Has profile ID but no name resolved");
                }
            } catch (Exception e) {
                DiscordChatIntegration.LOGGER.debug("Method 4 failed: {}", e.getMessage());
            }
            
        } catch (Exception e) {
            DiscordChatIntegration.LOGGER.error("Error getting player name: {}", e.getMessage());
        }
        return null;
    }
    
    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        connections.remove(conn);
        DiscordChatIntegration.LOGGER.info("Discord client disconnected: {} (code: {})", reason, code);
        
        // Show disconnection notification in chat if no more connections
        if (connections.isEmpty()) {
            showConnectionNotification(false);
        }
    }
    
    @Override
    public void onMessage(WebSocket conn, String message) {
        // Process messages asynchronously to avoid blocking the WebSocket thread
        // Use execute() instead of submit() for better performance (fire-and-forget)
        messageExecutor.execute(() -> {
            try {
                JsonObject json = GSON.fromJson(message, JsonObject.class);
                String type = json.has("type") ? json.get("type").getAsString() : "";
                
                if ("discord_message".equals(type)) {
                    String author = json.has("author") ? json.get("author").getAsString() : "Unknown";
                    String content = json.has("content") ? json.get("content").getAsString() : "";
                    String messageId = json.has("messageId") ? json.get("messageId").getAsString() : null;
                    
                    if (messageHandler != null && !content.isEmpty()) {
                        // Execute handler - this should only be called once per message
                        messageHandler.accept(new ChatMessage(author, content, messageId));
                    }
                } else if ("ping".equals(type)) {
                    // Respond to ping immediately (non-blocking)
                    JsonObject pong = new JsonObject();
                    pong.addProperty("type", "pong");
                    conn.send(GSON.toJson(pong));
                }
            } catch (Exception e) {
                DiscordChatIntegration.LOGGER.error("Error parsing message from Discord client: {}", e.getMessage(), e);
            }
        });
    }
    
    @Override
    public void onError(WebSocket conn, Exception ex) {
        // Check if it's a bind error (port already in use)
        if (ex.getMessage() != null && (ex.getMessage().contains("Address already in use") || 
            ex.getMessage().contains("BindException") || 
            ex.getMessage().contains("already bound"))) {
            DiscordChatIntegration.LOGGER.error("Port {} is already in use", getPort());
        } else {
            DiscordChatIntegration.LOGGER.error("WebSocket error: {}", ex.getMessage());
        }
        if (conn != null) {
            connections.remove(conn);
        }
    }
    
    @Override
    public void onStart() {
        running = true;
        DiscordChatIntegration.LOGGER.info("Discord WebSocket server started on port {}", getPort());
    }
    
    public void broadcastMinecraftMessage(String playerName, String message) {
        JsonObject json = new JsonObject();
        json.addProperty("type", "minecraft_message");
        json.addProperty("author", playerName);
        json.addProperty("content", message);
        
        String jsonString = GSON.toJson(json);
        synchronized (connections) {
            connections.removeIf(conn -> !conn.isOpen()); // Remove closed connections
            for (WebSocket conn : connections) {
                conn.send(jsonString);
            }
        }
    }
    
    public int getConnectionCount() {
        return connections.size();
    }
    
    public boolean isRunning() {
        return running;
    }
    
    public void stopServer() {
        try {
            running = false;
            // Shutdown message executor
            messageExecutor.shutdown();
            for (WebSocket conn : connections) {
                conn.close(1000, "Server shutting down");
            }
            connections.clear();
            this.stop(1000);
            DiscordChatIntegration.LOGGER.info("Discord WebSocket server stopped");
        } catch (InterruptedException e) {
            DiscordChatIntegration.LOGGER.error("Error stopping WebSocket server: {}", e.getMessage());
            Thread.currentThread().interrupt();
        }
    }
    
    /**
     * Show a connection/disconnection notification in the Minecraft chat.
     */
    private void showConnectionNotification(boolean connected) {
        Minecraft client = Minecraft.getInstance();
        if (client != null && client.player != null) {
            client.execute(() -> {
                String message = connected 
                    ? "§a[Discord] Connected to Discord chat bridge"
                    : "§c[Discord] Disconnected from Discord chat bridge";
                client.player.displayClientMessage(Component.literal(message), false);
            });
        }
    }
    
    public static class ChatMessage {
        public final String author;
        public final String content;
        public final String messageId; // Discord message ID for duplicate detection
        
        public ChatMessage(String author, String content, String messageId) {
            this.author = author;
            this.content = content;
            this.messageId = messageId;
        }
    }
}

