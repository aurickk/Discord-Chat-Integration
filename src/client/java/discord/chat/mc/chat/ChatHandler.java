package discord.chat.mc.chat;

import discord.chat.mc.DiscordChatIntegration;
import discord.chat.mc.websocket.DiscordWebSocketServer;
import net.minecraft.client.Minecraft;

import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

public class ChatHandler {
    private static ChatHandler instance;
    
    // Flag to prevent loops when sending messages from Discord
    private boolean isSendingFromDiscord = false;
    
    // Track processed messages to prevent duplicates (message content + timestamp)
    private static final long DEDUP_WINDOW_MS = 5000; // 5 seconds
    private final Map<String, Long> processedMessages = Collections.synchronizedMap(new HashMap<>());
    
    public static ChatHandler getInstance() {
        if (instance == null) {
            instance = new ChatHandler();
        }
        return instance;
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
        
        // Process deduplication and message sending asynchronously to prevent freezing
        new Thread(() -> {
            // Do deduplication check
            String dedupKey = message.author + "|" + message.content;
            long now = System.currentTimeMillis();
            
            // Quick check first
            synchronized (processedMessages) {
                Long lastProcessed = processedMessages.get(dedupKey);
                if (lastProcessed != null && (now - lastProcessed) < DEDUP_WINDOW_MS) {
                    DiscordChatIntegration.LOGGER.debug("Skipping duplicate Discord message: {}", message.content);
                    return;
                }
                
                // Mark as processed immediately
                processedMessages.put(dedupKey, now);
                
                // Clean up old entries if needed
                if (processedMessages.size() > 100) {
                    long cleanupTime = System.currentTimeMillis();
                    processedMessages.entrySet().removeIf(entry -> (cleanupTime - entry.getValue()) > DEDUP_WINDOW_MS);
                }
            }
            
            DiscordChatIntegration.LOGGER.debug("Processing Discord message from {}: {}", message.author, message.content);
            
            // Set flag to prevent this message from being sent back to Discord
            isSendingFromDiscord = true;
            
            // Execute on the main thread - send as actual chat message
            // This is non-blocking as it's queued on the main thread
            client.execute(() -> {
                try {
                    // Check if it's a command (starts with /)
                    if (message.content.startsWith("/")) {
                        // Send as command (remove the leading /)
                        String command = message.content.substring(1);
                        client.player.connection.sendCommand(command);
                    } else {
                        // Send as regular chat message - appears as if player typed it
                        client.player.connection.sendChat(message.content);
                    }
                } catch (Exception e) {
                    DiscordChatIntegration.LOGGER.error("Error sending message to chat: {}", e.getMessage());
                } finally {
                    // Reset flag after a short delay to allow the message to be processed
                    new Thread(() -> {
                        try {
                            Thread.sleep(100);
                        } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                        }
                        isSendingFromDiscord = false;
                    }, "Discord-Chat-Reset").start();
                }
            });
        }, "Discord-Message-Processor").start();
    }
    
    /**
     * Called when the local player sends a chat message.
     * Logs it to console for Discord clients to receive.
     */
    public void handleOutgoingMinecraftMessage(String message) {
        // Don't log messages that came from Discord (prevent loop)
        if (isSendingFromDiscord) {
            return;
        }
        
        Minecraft client = Minecraft.getInstance();
        if (client.player != null) {
            String playerName = client.player.getName().getString();
            sendToDiscordForLogging(playerName, message);
        }
    }
    
    /**
     * Called when a chat message is received from the server.
     * Logs it to console for Discord clients to receive.
     */
    public void handleIncomingMinecraftMessage(String playerName, String message) {
        sendToDiscordForLogging(playerName, message);
    }
    
    /**
     * Send a message to connected Discord clients for console logging only.
     */
    private void sendToDiscordForLogging(String playerName, String message) {
        // Don't log messages that came from Discord (prevent loop)
        if (isSendingFromDiscord) {
            return;
        }
        
        DiscordWebSocketServer server = DiscordWebSocketServer.getInstance();
        if (server != null && server.isRunning() && server.getConnectionCount() > 0) {
            server.broadcastMinecraftMessage(playerName, message);
        }
    }
}

