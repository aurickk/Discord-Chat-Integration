package discord.chat.mc.mixin.client;

import discord.chat.mc.chat.ChatHandler;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;


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
            

            ChatHandler.getInstance().handleIncomingMinecraftMessage("System", cleanContent);
        } catch (Exception e) {
            // Silently ignore errors
        }
    }
}

