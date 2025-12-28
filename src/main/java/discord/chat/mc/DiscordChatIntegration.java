package discord.chat.mc;

import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class DiscordChatIntegration implements ModInitializer {
	public static final String MOD_ID = "discord-chat-integration";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		LOGGER.info("Discord Chat Integration initialized");
	}
}