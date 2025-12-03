package discord.chat.mc.mixin.client;

import discord.chat.mc.chat.ChatHandler;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundPlayerChatPacket;
import net.minecraft.network.protocol.game.ClientboundSystemChatPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import java.util.UUID;

/**
 * Mixin to intercept incoming chat messages from the server.
 */
@Mixin(ClientPacketListener.class)
public class ClientPacketListenerMixin {
    
    @Inject(method = "handlePlayerChat", at = @At("TAIL"))
    private void onPlayerChat(ClientboundPlayerChatPacket packet, CallbackInfo ci) {
        try {
            Minecraft client = Minecraft.getInstance();
            
            // Get the sender's name
            UUID senderId = packet.sender();
            String senderName = "Unknown";
            
            if (client.level != null) {
                var player = client.level.getPlayerByUUID(senderId);
                if (player != null) {
                    senderName = player.getName().getString();
                }
            }
            
            // Don't forward our own messages (they're already sent via ChatScreenMixin)
            if (client.player != null && senderId.equals(client.player.getUUID())) {
                return;
            }
            
            // Get the message content
            String messageContent = packet.body().content();
            
            if (!messageContent.isEmpty()) {
                ChatHandler.getInstance().handleIncomingMinecraftMessage(senderName, messageContent);
            }
        } catch (Exception e) {
            // Silently ignore errors to not break chat
        }
    }
    
    @Inject(method = "handleSystemChat", at = @At("TAIL"))
    private void onSystemChat(ClientboundSystemChatPacket packet, CallbackInfo ci) {
        try {
            // Forward ALL system messages including overlays (command feedback, errors, server messages, etc.)
            // Overlay messages can also contain important command feedback
            String content = packet.content().getString();
            
            // Remove formatting codes for cleaner logging
            String cleanContent = content.replaceAll("§.", "");
            
            if (!cleanContent.isEmpty()) {
                // Send the full message content as-is (no parsing/filtering)
                // This captures command errors, feedback, and all other system messages
                ChatHandler.getInstance().handleIncomingMinecraftMessage("System", cleanContent);
            }
        } catch (Exception e) {
            // Silently ignore errors to not break chat
        }
    }
}

