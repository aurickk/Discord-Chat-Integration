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
    
    // Config values
    private int port = 25580;
    
    // Transient fields (not saved)
    private transient Path configPath;
    
    public static ModConfig getInstance() {
        if (instance == null) {
            instance = load();
        }
        return instance;
    }
    
    private static Path getConfigPath() {
        return FabricLoader.getInstance().getConfigDir().resolve(CONFIG_FILE);
    }
    
    public static ModConfig load() {
        Path configPath = getConfigPath();
        
        if (Files.exists(configPath)) {
            try {
                String json = Files.readString(configPath);
                ModConfig config = GSON.fromJson(json, ModConfig.class);
                config.configPath = configPath;
                DiscordChatIntegration.LOGGER.info("Loaded config from {}", configPath);
                return config;
            } catch (IOException e) {
                DiscordChatIntegration.LOGGER.error("Failed to load config: {}", e.getMessage());
            }
        }
        
        // Create default config
        ModConfig config = new ModConfig();
        config.configPath = configPath;
        config.save();
        return config;
    }
    
    public void save() {
        try {
            if (configPath == null) {
                configPath = getConfigPath();
            }
            
            // Ensure parent directory exists
            Files.createDirectories(configPath.getParent());
            
            String json = GSON.toJson(this);
            Files.writeString(configPath, json);
            DiscordChatIntegration.LOGGER.info("Saved config to {}", configPath);
        } catch (IOException e) {
            DiscordChatIntegration.LOGGER.error("Failed to save config: {}", e.getMessage());
        }
    }
    
    // Getters and setters
    public int getPort() {
        return port;
    }
    
    public void setPort(int port) {
        this.port = port;
    }
}

