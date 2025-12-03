package discord.chat.mc.mixin.client;

import discord.chat.mc.chat.ChatHandler;
import net.minecraft.client.gui.screens.ChatScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Mixin to intercept outgoing chat messages from the chat screen.
 */
@Mixin(ChatScreen.class)
public class ChatScreenMixin {
    
    @Inject(method = "handleChatInput", at = @At("HEAD"))
    private void onChatInput(String message, boolean addToHistory, CallbackInfo ci) {
        // Forward ALL messages including commands (command feedback will come through system chat)
        ChatHandler.getInstance().handleOutgoingMinecraftMessage(message);
    }
}

