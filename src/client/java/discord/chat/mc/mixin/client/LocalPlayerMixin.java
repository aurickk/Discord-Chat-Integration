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
            if (overlay) return;
            
            String content = message.getString().replaceAll("§.", "");
            if (!content.isEmpty()) {
                ChatHandler.getInstance().handleIncomingMinecraftMessage("System", content);
            }
        } catch (Exception ignored) {}
    }
}

