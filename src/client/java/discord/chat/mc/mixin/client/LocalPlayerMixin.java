package discord.chat.mc.mixin.client;

import discord.chat.mc.chat.ChatHandler;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Mixin to intercept messages displayed to the local player.
 * This catches ALL command feedback (both server-side and client-side mod commands).
 * 
 * Root cause of duplication (FIXED):
 * - Server commands: ClientboundSystemChatPacket → handleSystemChat → displayClientMessage (here)
 * - Client commands: displayClientMessage directly (here)
 * 
 * Previously, ClientPacketListenerMixin.handleSystemChat was ALSO forwarding server command feedback,
 * causing duplicates. Now we only forward here, at the displayClientMessage level.
 */
@Mixin(net.minecraft.client.player.LocalPlayer.class)
public class LocalPlayerMixin {
    
    @Inject(method = "displayClientMessage(Lnet/minecraft/network/chat/Component;Z)V", at = @At("TAIL"))
    private void onDisplayClientMessage(Component message, boolean overlay, CallbackInfo ci) {
        try {
            // Only process chat messages (overlay=false), not action bar messages (overlay=true)
            // Action bar messages are handled by ClientPacketListenerMixin.handleSystemChat
            if (overlay) {
                return;
            }
            
            // Get the plain text content
            String content = message.getString();
            
            // Remove formatting codes
            String cleanContent = content.replaceAll("§.", "");
            
            if (cleanContent.isEmpty()) {
                return;
            }
            
            // Forward ALL non-overlay messages to Discord
            // This catches:
            // - Client-side mod command feedback (e.g., "[Pay Everyone] Auto-confirm disabled")
            // - Server command feedback (may duplicate with ClientPacketListenerMixin, but deduplication handles it)
            // - Any other messages displayed to the player
            ChatHandler.getInstance().handleIncomingMinecraftMessage("System", cleanContent);
        } catch (Exception e) {
            // Silently ignore errors
        }
    }
}

