package discord.chat.mc.mixin.client;

import discord.chat.mc.chat.ChatHandler;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.network.chat.Component;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Mixin to intercept messages added directly to the chat component.
 * This catches messages that might bypass displayClientMessage.
 */
@Mixin(ChatComponent.class)
public class ChatComponentMixin {
    
    // Only intercept the method with signature - this is the one that's actually called
    // The single-parameter version typically delegates to this one
    @Inject(method = "addMessage(Lnet/minecraft/network/chat/Component;Lnet/minecraft/network/chat/MessageSignature;Lnet/minecraft/client/GuiMessageTag;)V", at = @At("TAIL"))
    private void onAddMessage(Component message, net.minecraft.network.chat.MessageSignature signature, net.minecraft.client.GuiMessageTag tag, CallbackInfo ci) {
        try {
            String content = message.getString();
            String cleanContent = content.replaceAll("§.", "");
            
            if (!cleanContent.isEmpty()) {
                ChatHandler.getInstance().handleIncomingMinecraftMessage("System", cleanContent);
            }
        } catch (Exception e) {
            // Silently ignore errors
        }
    }
}