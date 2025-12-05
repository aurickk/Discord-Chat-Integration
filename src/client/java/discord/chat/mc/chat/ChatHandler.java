package discord.chat.mc.chat;

import discord.chat.mc.DiscordChatIntegration;
import discord.chat.mc.websocket.DiscordWebSocketServer;
import net.minecraft.client.Minecraft;

import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ConcurrentHashMap;

public class ChatHandler {
    private static ChatHandler instance;
    
    // Flag to prevent loops when sending messages from Discord (using atomic for thread safety)
    private final AtomicBoolean isSendingFromDiscord = new AtomicBoolean(false);
    
    // Track processed message IDs to prevent duplicates from Discord
    private final ConcurrentHashMap<String, Boolean> processedMessageIds = new ConcurrentHashMap<>();
    
    // Track messages sent from Discord to prevent them from being echoed back
    // When we send a message from Discord to Minecraft, the chat displays it, which triggers
    // ChatComponentMixin, and we need to ignore that echo
    private final ConcurrentHashMap<String, Long> sentFromDiscord = new ConcurrentHashMap<>();
    private static final long SENT_FROM_DISCORD_WINDOW_MS = 3000;
    
    // Thread pool for processing messages (reuse threads instead of creating new ones)
    private final ExecutorService messageProcessor = Executors.newFixedThreadPool(2, r -> {
        Thread t = new Thread(r, "Discord-Message-Processor");
        t.setDaemon(true);
        t.setPriority(Thread.NORM_PRIORITY);
        return t;
    });
    
    // Single-threaded executor for forwarding messages to Discord to ensure order
    private final ExecutorService discordForwardExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "Discord-Forward-Processor");
        t.setDaemon(true);
        t.setPriority(Thread.NORM_PRIORITY);
        return t;
    });
    
    public static ChatHandler getInstance() {
        if (instance == null) {
            instance = new ChatHandler();
            // Pre-warm the thread pool to avoid first-message delay
            instance.warmupThreadPool();
        }
        return instance;
    }
    
    private void warmupThreadPool() {
        messageProcessor.execute(() -> {}); // Pre-warm thread pool
    }
    
    /**
     * Called when a message is received from Discord.
     * Sends the message to the actual game chat so others can see it.
     */
    public void handleDiscordMessage(DiscordWebSocketServer.ChatMessage message) {
        Minecraft client = Minecraft.getInstance();
        if (client == null || client.player == null || client.player.connection == null) {
            return;
        }
        
        // Process message sending asynchronously using thread pool
        messageProcessor.execute(() -> {
            try {
                // Check for duplicates using message ID
                if (message.messageId != null && !message.messageId.isEmpty()) {
                    if (processedMessageIds.putIfAbsent(message.messageId, Boolean.TRUE) != null) {
                        return; // Duplicate
                    }
                    // Clean up old message IDs periodically
                    if (processedMessageIds.size() > 2000) {
                        processedMessageIds.clear();
                    }
                }
                
                // Set flag to prevent this message from being sent back to Discord
                if (!isSendingFromDiscord.compareAndSet(false, true)) {
                    return;
                }
                
                // Track the message content to prevent echo back
                // The message will appear in chat and ChatComponentMixin will catch it
                // We need to ignore that echo
                String playerName = getPlayerName(client);
                if (playerName != null) {
                    String expectedEcho = "<" + playerName + "> " + message.content;
                    sentFromDiscord.put(expectedEcho, System.currentTimeMillis());
                }
                
                // Also track the raw content in case format varies
                sentFromDiscord.put(message.content, System.currentTimeMillis());
                
                // Clean up old entries
                if (sentFromDiscord.size() > 100) {
                    long cutoff = System.currentTimeMillis() - SENT_FROM_DISCORD_WINDOW_MS;
                    sentFromDiscord.entrySet().removeIf(entry -> entry.getValue() < cutoff);
                }
                
                // Execute on the main thread - send as actual chat message
                client.execute(() -> {
                    try {
                        if (message.content.startsWith("/")) {
                            client.player.connection.sendCommand(message.content.substring(1));
                        } else {
                            client.player.connection.sendChat(message.content);
                        }
                    } catch (Exception e) {
                        DiscordChatIntegration.LOGGER.error("Error sending message to chat: {}", e.getMessage());
                    } finally {
                        // Reset flag asynchronously after message is queued
                        messageProcessor.execute(() -> {
                            try {
                                Thread.sleep(100);
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                            isSendingFromDiscord.set(false);
                        });
                    }
                });
            } catch (Exception e) {
                DiscordChatIntegration.LOGGER.error("Error processing Discord message: {}", e.getMessage(), e);
            }
        });
    }
    
    public void handleIncomingMinecraftMessage(String playerName, String message) {
        // Check if this message was sent from Discord (echo prevention)
        long now = System.currentTimeMillis();
        
        // Check if the exact message content matches something we sent from Discord
        Long sentTime = sentFromDiscord.get(message);
        if (sentTime != null && (now - sentTime) < SENT_FROM_DISCORD_WINDOW_MS) {
            sentFromDiscord.remove(message);
            return; // This is an echo of a message sent from Discord
        }
        
        // Also check for formatted message (e.g., "<PlayerName> content")
        // Clean up old entries while we're at it
        if (sentFromDiscord.size() > 0) {
            long cutoff = now - SENT_FROM_DISCORD_WINDOW_MS;
            for (var entry : sentFromDiscord.entrySet()) {
                if (entry.getValue() < cutoff) {
                    sentFromDiscord.remove(entry.getKey());
                } else if (message.contains(entry.getKey()) || entry.getKey().equals(message)) {
                    sentFromDiscord.remove(entry.getKey());
                    return; // This is an echo
                }
            }
        }
        
        sendToDiscordForLogging(playerName, message);
    }
    
    private void sendToDiscordForLogging(String playerName, String message) {
        // Use single-threaded executor to ensure messages are sent in order
        discordForwardExecutor.execute(() -> {
            DiscordWebSocketServer server = DiscordWebSocketServer.getInstance();
            if (server != null && server.isRunning() && server.getConnectionCount() > 0) {
                server.broadcastMinecraftMessage(playerName, message);
            }
        });
    }
    
    /**
     * Get player name using multiple methods for cross-version compatibility.
     */
    private String getPlayerName(Minecraft client) {
        if (client == null || client.player == null) return null;
        
        // Method 1: Try player.getName().getString()
        try {
            String name = client.player.getName().getString();
            if (name != null && !name.isEmpty() && !name.equals("Player")) {
                return name;
            }
        } catch (Exception ignored) {}
        
        // Method 2: Try player.getGameProfile().getName()
        try {
            String name = client.player.getGameProfile().getName();
            if (name != null && !name.isEmpty() && !name.equals("Player")) {
                return name;
            }
        } catch (Exception ignored) {}
        
        // Method 3: Try getUser().getName()
        try {
            if (client.getUser() != null) {
                String name = client.getUser().getName();
                if (name != null && !name.isEmpty() && !name.equals("Player")) {
                    return name;
                }
            }
        } catch (Exception ignored) {}
        
        return null;
    }
    
    /**
     * Shutdown thread pools when mod is stopping.
     */
    public void shutdown() {
        messageProcessor.shutdown();
        discordForwardExecutor.shutdown();
        try {
            if (!messageProcessor.awaitTermination(2, TimeUnit.SECONDS)) {
                messageProcessor.shutdownNow();
            }
            if (!discordForwardExecutor.awaitTermination(2, TimeUnit.SECONDS)) {
                discordForwardExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            messageProcessor.shutdownNow();
            discordForwardExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
}

