package discord.chat.mc.config;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import discord.chat.mc.DiscordChatIntegration;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class ModConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final String CONFIG_FILE = "discord-chat-integration.json";
    private static ModConfig instance;
    
    private int port = 25580;
    private transient Path configPath;
    
    public static ModConfig getInstance() {
        if (instance == null) instance = load();
        return instance;
    }
    
    private static Path getConfigPath() {
        return FabricLoader.getInstance().getConfigDir().resolve(CONFIG_FILE);
    }
    
    public static ModConfig load() {
        Path configPath = getConfigPath();
        
        if (Files.exists(configPath)) {
            try {
                ModConfig config = GSON.fromJson(Files.readString(configPath), ModConfig.class);
                config.configPath = configPath;
                return config;
            } catch (IOException e) {
                DiscordChatIntegration.LOGGER.error("Failed to load config: {}", e.getMessage());
            }
        }
        
        ModConfig config = new ModConfig();
        config.configPath = configPath;
        config.save();
        return config;
    }
    
    public void save() {
        try {
            if (configPath == null) configPath = getConfigPath();
            Files.createDirectories(configPath.getParent());
            Files.writeString(configPath, GSON.toJson(this));
        } catch (IOException e) {
            DiscordChatIntegration.LOGGER.error("Failed to save config: {}", e.getMessage());
        }
    }
    
    public int getPort() { return port; }
    public void setPort(int port) { this.port = port; }
}

