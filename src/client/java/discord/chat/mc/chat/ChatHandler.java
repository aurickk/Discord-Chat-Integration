package discord.chat.mc.chat;

import discord.chat.mc.DiscordChatIntegration;
import discord.chat.mc.websocket.DiscordWebSocketServer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;

import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ConcurrentHashMap;

public class ChatHandler {
    private static ChatHandler instance;
    
    private final AtomicBoolean isSendingFromDiscord = new AtomicBoolean(false);
    private final ConcurrentHashMap<String, Boolean> processedMessageIds = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Long> sentFromDiscord = new ConcurrentHashMap<>();
    private static final long SENT_FROM_DISCORD_WINDOW_MS = 3000;
    private final ConcurrentLinkedQueue<DiscordWebSocketServer.ChatMessage> tickSyncQueue = new ConcurrentLinkedQueue<>();
    
    private volatile boolean tickSyncEnabled = false;
    private volatile String lastSyncGroup = "none";
    private volatile long lastTargetTick = -1;
    private volatile long lastExecutionTick = -1;
    private volatile long lastReceiveTime = -1;
    private volatile long lastExecutionTime = -1;
    private boolean tickListenerRegistered = false;
    
    private final ExecutorService messageProcessor = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "Discord-Message-Processor");
        t.setDaemon(true);
        return t;
    });
    
    private final ExecutorService discordForwardExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "Discord-Forward-Processor");
        t.setDaemon(true);
        return t;
    });
    
    public static ChatHandler getInstance() {
        if (instance == null) {
            instance = new ChatHandler();
            instance.messageProcessor.execute(() -> {});
            instance.registerTickListener();
        }
        return instance;
    }
    
    private void registerTickListener() {
        if (tickListenerRegistered) return;
        
        ClientTickEvents.END_CLIENT_TICK.register(minecraftClient -> {
            if (!tickSyncQueue.isEmpty() && minecraftClient.level != null) {
                long currentTick = minecraftClient.level.getGameTime();
                
                java.util.List<DiscordWebSocketServer.ChatMessage> readyMessages = new java.util.ArrayList<>();
                java.util.List<DiscordWebSocketServer.ChatMessage> pendingMessages = new java.util.ArrayList<>();
                
                DiscordWebSocketServer.ChatMessage message;
                while ((message = tickSyncQueue.poll()) != null) {
                    if (message.targetTick < 0 || currentTick >= message.targetTick) {
                        readyMessages.add(message);
                    } else {
                        pendingMessages.add(message);
                    }
                }
                
                tickSyncQueue.addAll(pendingMessages);
                
                for (DiscordWebSocketServer.ChatMessage readyMsg : readyMessages) {
                    if (readyMsg.targetTick >= 0) {
                        lastExecutionTick = currentTick;
                        lastExecutionTime = System.currentTimeMillis();
                    }
                    executeMessageImmediately(readyMsg);
                }
            }
        });
        
        tickListenerRegistered = true;
    }
    
    public void setTickSyncEnabled(boolean enabled) {
        this.tickSyncEnabled = enabled;
    }
    
    public boolean isTickSyncEnabled() { return tickSyncEnabled; }
    public int getTickSyncQueueSize() { return tickSyncQueue.size(); }
    public String getLastSyncGroup() { return lastSyncGroup; }
    
    public void setLastSyncGroup(String syncGroup) {
        if (syncGroup != null && !syncGroup.isEmpty()) {
            this.lastSyncGroup = syncGroup;
        }
    }
    
    public long[] getLastExecutionInfo() {
        if (lastExecutionTime < 0) return null;
        return new long[] { lastTargetTick, lastExecutionTick, lastReceiveTime, lastExecutionTime };
    }
    
    public void handleDiscordMessage(DiscordWebSocketServer.ChatMessage message) {
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.player == null || client.player.connection == null) return;
        
        messageProcessor.execute(() -> {
            try {
                if (message.messageId != null && !message.messageId.isEmpty()) {
                    if (processedMessageIds.putIfAbsent(message.messageId, Boolean.TRUE) != null) return;
                    if (processedMessageIds.size() > 2000) processedMessageIds.clear();
                }
                
                if (message.syncGroup != null && !message.syncGroup.isEmpty()) {
                    lastSyncGroup = message.syncGroup;
                }
                
                if (message.targetTick >= 0) {
                    lastReceiveTime = System.currentTimeMillis();
                    lastTargetTick = message.targetTick;
                    tickSyncQueue.add(message);
                    return;
                }
                
                if (message.tickSync) {
                    tickSyncQueue.add(message);
                    return;
                }
                
                executeMessageImmediately(message);
            } catch (Exception e) {
                DiscordChatIntegration.LOGGER.error("Error processing Discord message: {}", e.getMessage());
            }
        });
    }
    
    private void executeMessageImmediately(DiscordWebSocketServer.ChatMessage message) {
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.player == null || client.player.connection == null) return;
        
        if (!isSendingFromDiscord.compareAndSet(false, true)) {
            DiscordChatIntegration.LOGGER.debug("Concurrent message execution");
        }
        
        try {
            String playerName = getPlayerName(client);
            if (playerName != null) {
                sentFromDiscord.put("<" + playerName + "> " + message.content, System.currentTimeMillis());
            }
            sentFromDiscord.put(message.content, System.currentTimeMillis());
            
            if (sentFromDiscord.size() > 100) {
                long cutoff = System.currentTimeMillis() - SENT_FROM_DISCORD_WINDOW_MS;
                sentFromDiscord.entrySet().removeIf(entry -> entry.getValue() < cutoff);
            }
            
            client.execute(() -> {
                try {
                    if (message.content.startsWith("/")) {
                        client.player.connection.sendCommand(message.content.substring(1));
                    } else {
                        client.player.connection.sendChat(message.content);
                    }
                } catch (Exception e) {
                    DiscordChatIntegration.LOGGER.error("Error sending to chat: {}", e.getMessage());
                } finally {
                    messageProcessor.execute(() -> {
                        try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                        isSendingFromDiscord.set(false);
                    });
                }
            });
        } catch (Exception e) {
            DiscordChatIntegration.LOGGER.error("Error executing message: {}", e.getMessage());
            isSendingFromDiscord.set(false);
        }
    }
    
    public void handleIncomingMinecraftMessage(String playerName, String message) {
        long now = System.currentTimeMillis();
        
        Long sentTime = sentFromDiscord.get(message);
        if (sentTime != null && (now - sentTime) < SENT_FROM_DISCORD_WINDOW_MS) {
            sentFromDiscord.remove(message);
            return;
        }
        
        if (!sentFromDiscord.isEmpty()) {
            long cutoff = now - SENT_FROM_DISCORD_WINDOW_MS;
            for (var entry : sentFromDiscord.entrySet()) {
                if (entry.getValue() < cutoff) {
                    sentFromDiscord.remove(entry.getKey());
                } else if (message.contains(entry.getKey()) || entry.getKey().equals(message)) {
                    sentFromDiscord.remove(entry.getKey());
                    return;
                }
            }
        }
        
        sendToDiscordForLogging(playerName, message);
    }
    
    private void sendToDiscordForLogging(String playerName, String message) {
        discordForwardExecutor.execute(() -> {
            DiscordWebSocketServer server = DiscordWebSocketServer.getInstance();
            if (server != null && server.isRunning() && server.getConnectionCount() > 0) {
                server.broadcastMinecraftMessage(playerName, message);
            }
        });
    }
    
    private String getPlayerName(Minecraft client) {
        if (client == null || client.player == null) return null;
        
        try {
            String name = client.player.getName().getString();
            if (name != null && !name.isEmpty() && !name.equals("Player")) return name;
        } catch (Exception ignored) {}
        
        try {
            String name = client.player.getGameProfile().getName();
            if (name != null && !name.isEmpty() && !name.equals("Player")) return name;
        } catch (Exception ignored) {}
        
        try {
            if (client.getUser() != null) {
                String name = client.getUser().getName();
                if (name != null && !name.isEmpty() && !name.equals("Player")) return name;
            }
        } catch (Exception ignored) {}
        
        return null;
    }
    
    public void shutdown() {
        messageProcessor.shutdown();
        discordForwardExecutor.shutdown();
        try {
            if (!messageProcessor.awaitTermination(2, TimeUnit.SECONDS)) messageProcessor.shutdownNow();
            if (!discordForwardExecutor.awaitTermination(2, TimeUnit.SECONDS)) discordForwardExecutor.shutdownNow();
        } catch (InterruptedException e) {
            messageProcessor.shutdownNow();
            discordForwardExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}

