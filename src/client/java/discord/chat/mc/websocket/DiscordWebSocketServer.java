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
import java.util.function.Consumer;

public class DiscordWebSocketServer extends WebSocketServer {
    private static final Gson GSON = new Gson();
    private static DiscordWebSocketServer instance;
    
    private final Set<WebSocket> connections = Collections.synchronizedSet(new HashSet<>());
    private Consumer<ChatMessage> messageHandler;
    private boolean running = false;
    
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
        
        // Send connection confirmation
        JsonObject response = new JsonObject();
        response.addProperty("type", "connection_status");
        response.addProperty("status", "connected");
        response.addProperty("message", "Connected to Minecraft Discord Chat Integration");
        conn.send(GSON.toJson(response));
        
        // Show connection notification in chat when first client connects
        if (connections.size() == 1) {
            showConnectionNotification(true);
        }
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
        try {
            JsonObject json = GSON.fromJson(message, JsonObject.class);
            String type = json.has("type") ? json.get("type").getAsString() : "";
            
            if ("discord_message".equals(type)) {
                String author = json.has("author") ? json.get("author").getAsString() : "Unknown";
                String content = json.has("content") ? json.get("content").getAsString() : "";
                
                if (messageHandler != null && !content.isEmpty()) {
                    messageHandler.accept(new ChatMessage(author, content));
                }
            } else if ("ping".equals(type)) {
                JsonObject pong = new JsonObject();
                pong.addProperty("type", "pong");
                conn.send(GSON.toJson(pong));
            }
        } catch (Exception e) {
            DiscordChatIntegration.LOGGER.error("Error parsing message from Discord client: {}", e.getMessage());
        }
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
            for (WebSocket conn : connections) {
                if (conn.isOpen()) {
                    conn.send(jsonString);
                }
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
            for (WebSocket conn : connections) {
                conn.close(1000, "Server shutting down");
            }
            connections.clear();
            this.stop(1000);
            DiscordChatIntegration.LOGGER.info("Discord WebSocket server stopped");
        } catch (InterruptedException e) {
            DiscordChatIntegration.LOGGER.error("Error stopping WebSocket server: {}", e.getMessage());
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
        
        public ChatMessage(String author, String content) {
            this.author = author;
            this.content = content;
        }
    }
}

