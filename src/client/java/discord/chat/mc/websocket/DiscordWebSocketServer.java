package discord.chat.mc.websocket;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import discord.chat.mc.DiscordChatIntegration;
import discord.chat.mc.chat.ChatHandler;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import org.java_websocket.WebSocket;
import org.java_websocket.drafts.Draft;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.handshake.ServerHandshakeBuilder;
import org.java_websocket.exceptions.InvalidDataException;
import org.java_websocket.server.WebSocketServer;

import java.net.InetSocketAddress;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

public class DiscordWebSocketServer extends WebSocketServer {
    private static final Gson GSON = new Gson();
    private static DiscordWebSocketServer instance;
    
    private final Set<WebSocket> connections = Collections.synchronizedSet(new HashSet<>());
    private Consumer<ChatMessage> messageHandler;
    private boolean running = false;
    
    private final ExecutorService messageExecutor = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "Discord-WebSocket-Message-Processor");
        t.setDaemon(true);
        return t;
    });
    
    private final ScheduledExecutorService tickBroadcaster = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "Discord-Tick-Broadcaster");
        t.setDaemon(true);
        return t;
    });
    
    public DiscordWebSocketServer(int port) {
        super(new InetSocketAddress("127.0.0.1", port));
        this.setReuseAddr(true);
    }
    
    @Override
    public ServerHandshakeBuilder onWebsocketHandshakeReceivedAsServer(
            WebSocket conn, Draft draft, ClientHandshake request) throws InvalidDataException {
        
        ServerHandshakeBuilder builder = super.onWebsocketHandshakeReceivedAsServer(conn, draft, request);
        String origin = request.getFieldValue("Origin");
        
        if (!isOriginAllowed(origin)) {
            DiscordChatIntegration.LOGGER.warn("Rejected WebSocket from disallowed origin: '{}'", origin);
            throw new InvalidDataException(403, "Origin not allowed: " + origin);
        }
        
        return builder;
    }
    
    private boolean isOriginAllowed(String origin) {
        if (origin == null || origin.isEmpty() || origin.equals("null")) return true;
        
        String lowerOrigin = origin.toLowerCase();
        if (isDiscordOrigin(lowerOrigin)) return true;
        if (lowerOrigin.startsWith("http://") || lowerOrigin.startsWith("https://")) return false;
        if (lowerOrigin.contains("://")) return false;
        
        return true;
    }
    
    private boolean isDiscordOrigin(String lowerOrigin) {
        return lowerOrigin.equals("https://discord.com") ||
               lowerOrigin.equals("https://discordapp.com") ||
               lowerOrigin.equals("https://ptb.discord.com") ||
               lowerOrigin.equals("https://canary.discord.com") ||
               lowerOrigin.equals("https://ptb.discordapp.com") ||
               lowerOrigin.equals("https://canary.discordapp.com") ||
               lowerOrigin.startsWith("https://localhost") ||
               lowerOrigin.startsWith("http://localhost") ||
               lowerOrigin.startsWith("http://127.0.0.1") ||
               lowerOrigin.startsWith("https://127.0.0.1");
    }
    
    public static DiscordWebSocketServer getInstance() { return instance; }
    
    public static void createInstance(int port) {
        if (instance != null && instance.running) instance.stopServer();
        instance = new DiscordWebSocketServer(port);
    }
    
    public void setMessageHandler(Consumer<ChatMessage> handler) { this.messageHandler = handler; }
    
    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        connections.add(conn);
        DiscordChatIntegration.LOGGER.info("Discord client connected from: {}", conn.getRemoteSocketAddress());
        
        JsonObject response = new JsonObject();
        response.addProperty("type", "connection_status");
        response.addProperty("status", "connected");
        response.addProperty("message", "Connected to Minecraft Discord Chat Integration");
        
        String playerName = getPlayerName();
        if (playerName != null) response.addProperty("playerName", playerName);
        conn.send(GSON.toJson(response));
        
        Minecraft client = Minecraft.getInstance();
        if (client != null) {
            new Thread(() -> {
                try {
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
                            break;
                        }
                    }
                } catch (Exception ignored) {}
            }, "PlayerName-Resolver").start();
        }
        
        if (connections.size() == 1) showConnectionNotification(true);
    }
    
    private String getPlayerName() {
        try {
            Minecraft client = Minecraft.getInstance();
            if (client == null) return null;
            
            if (client.player != null) {
                try {
                    String name = client.player.getName().getString();
                    if (name != null && !name.isEmpty() && !name.equals("Player")) return name;
                } catch (Exception ignored) {}
                
                try {
                    String name = client.player.getGameProfile().getName();
                    if (name != null && !name.isEmpty() && !name.equals("Player")) return name;
                } catch (Exception ignored) {}
            }
            
            try {
                if (client.getUser() != null) {
                    String name = client.getUser().getName();
                    if (name != null && !name.isEmpty() && !name.equals("Player")) return name;
                }
            } catch (Exception ignored) {}
        } catch (Exception ignored) {}
        return null;
    }
    
    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        connections.remove(conn);
        DiscordChatIntegration.LOGGER.info("Discord client disconnected (code: {})", code);
        if (connections.isEmpty()) showConnectionNotification(false);
    }
    
    @Override
    public void onMessage(WebSocket conn, String message) {
        messageExecutor.execute(() -> {
            try {
                JsonObject json = GSON.fromJson(message, JsonObject.class);
                String type = json.has("type") ? json.get("type").getAsString() : "";
                
                if ("discord_message".equals(type)) {
                    String author = json.has("author") ? json.get("author").getAsString() : "Unknown";
                    String content = json.has("content") ? json.get("content").getAsString() : "";
                    String messageId = json.has("messageId") ? json.get("messageId").getAsString() : null;
                    boolean tickSync = json.has("tickSync") && json.get("tickSync").getAsBoolean();
                    String syncGroup = json.has("syncGroup") ? json.get("syncGroup").getAsString() : "none";
                    long targetTick = json.has("targetTick") ? json.get("targetTick").getAsLong() : -1;
                    
                    if (messageHandler != null && !content.isEmpty()) {
                        messageHandler.accept(new ChatMessage(author, content, messageId, tickSync, syncGroup, targetTick));
                    }
                } else if ("set_sync_group".equals(type)) {
                    String syncGroup = json.has("syncGroup") ? json.get("syncGroup").getAsString() : "none";
                    ChatHandler.getInstance().setLastSyncGroup(syncGroup);
                } else if ("get_tick".equals(type)) {
                    sendCurrentTick(conn);
                } else if ("ping".equals(type)) {
                    JsonObject pong = new JsonObject();
                    pong.addProperty("type", "pong");
                    conn.send(GSON.toJson(pong));
                } else if ("tick_sync_enable".equals(type)) {
                    ChatHandler.getInstance().setTickSyncEnabled(true);
                } else if ("tick_sync_disable".equals(type)) {
                    ChatHandler.getInstance().setTickSyncEnabled(false);
                } else if ("request_player_info".equals(type)) {
                    sendPlayerInfo(conn);
                }
            } catch (Exception e) {
                DiscordChatIntegration.LOGGER.error("Error parsing WebSocket message: {}", e.getMessage());
            }
        });
    }
    
    @Override
    public void onError(WebSocket conn, Exception ex) {
        String msg = ex.getMessage();
        if (msg != null && (msg.contains("Address already in use") || msg.contains("BindException") || msg.contains("already bound"))) {
            DiscordChatIntegration.LOGGER.error("Port {} is already in use", getPort());
        } else {
            DiscordChatIntegration.LOGGER.error("WebSocket error: {}", msg);
        }
        if (conn != null) connections.remove(conn);
    }
    
    @Override
    public void onStart() {
        running = true;
        DiscordChatIntegration.LOGGER.info("Discord WebSocket server started on port {}", getPort());
        
        tickBroadcaster.scheduleAtFixedRate(() -> {
            try {
                if (!connections.isEmpty()) broadcastCurrentTick();
            } catch (Exception ignored) {}
        }, 1000, 500, TimeUnit.MILLISECONDS);
    }
    
    public long getCurrentServerTick() {
        try {
            Minecraft client = Minecraft.getInstance();
            if (client != null && client.level != null) return client.level.getGameTime();
        } catch (Exception ignored) {}
        return -1;
    }
    
    public void broadcastCurrentTick() {
        long tick = getCurrentServerTick();
        if (tick < 0) return;
        
        JsonObject json = new JsonObject();
        json.addProperty("type", "tick_update");
        json.addProperty("tick", tick);
        
        String jsonString = GSON.toJson(json);
        synchronized (connections) {
            for (WebSocket conn : connections) {
                if (conn.isOpen()) conn.send(jsonString);
            }
        }
    }
    
    private void sendCurrentTick(WebSocket conn) {
        JsonObject json = new JsonObject();
        json.addProperty("type", "tick_update");
        json.addProperty("tick", getCurrentServerTick());
        conn.send(GSON.toJson(json));
    }
    
    private void sendPlayerInfo(WebSocket conn) {
        String playerName = getPlayerName();
        Minecraft client = Minecraft.getInstance();
        boolean inWorld = client != null && client.level != null;
        boolean inMultiplayer = client != null && !client.isSingleplayer() && client.level != null;
        
        JsonObject json = new JsonObject();
        json.addProperty("type", "player_info");
        json.addProperty("name", playerName != null ? playerName : "Unknown");
        json.addProperty("inWorld", inWorld);
        json.addProperty("inMultiplayer", inMultiplayer);
        if (inWorld) json.addProperty("serverTick", getCurrentServerTick());
        
        conn.send(GSON.toJson(json));
    }
    
    public void broadcastMinecraftMessage(String playerName, String message) {
        JsonObject json = new JsonObject();
        json.addProperty("type", "minecraft_message");
        json.addProperty("author", playerName);
        json.addProperty("content", message);
        
        String jsonString = GSON.toJson(json);
        synchronized (connections) {
            connections.removeIf(conn -> !conn.isOpen());
            for (WebSocket conn : connections) conn.send(jsonString);
        }
    }
    
    public int getConnectionCount() { return connections.size(); }
    public boolean isRunning() { return running; }
    
    public void stopServer() {
        try {
            running = false;
            messageExecutor.shutdown();
            tickBroadcaster.shutdown();
            for (WebSocket conn : connections) conn.close(1000, "Server shutting down");
            connections.clear();
            this.stop(1000);
            DiscordChatIntegration.LOGGER.info("Discord WebSocket server stopped");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
    
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
        public final String messageId;
        public final boolean tickSync;
        public final String syncGroup;
        public final long targetTick;
        
        public ChatMessage(String author, String content, String messageId) {
            this(author, content, messageId, false, "none", -1);
        }
        
        public ChatMessage(String author, String content, String messageId, boolean tickSync, String syncGroup) {
            this(author, content, messageId, tickSync, syncGroup, -1);
        }
        
        public ChatMessage(String author, String content, String messageId, boolean tickSync, String syncGroup, long targetTick) {
            this.author = author;
            this.content = content;
            this.messageId = messageId;
            this.tickSync = tickSync;
            this.syncGroup = syncGroup != null ? syncGroup : "none";
            this.targetTick = targetTick;
        }
    }
}

