package discord.chat.mc.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import discord.chat.mc.config.ModConfig;
import discord.chat.mc.websocket.DiscordWebSocketServer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.network.chat.Component;

public class DiscordCommand {
    
    public static void register() {
        ClientCommandRegistrationCallback.EVENT.register(DiscordCommand::registerCommands);
    }
    
    private static void registerCommands(CommandDispatcher<FabricClientCommandSource> dispatcher, CommandBuildContext registryAccess) {
        dispatcher.register(
            ClientCommandManager.literal("discordchat")
                .executes(context -> {
                    showStatus(context.getSource());
                    return 1;
                })
                .then(ClientCommandManager.literal("status")
                    .executes(context -> {
                        showStatus(context.getSource());
                        return 1;
                    })
                )
                .then(ClientCommandManager.literal("port")
                    .then(ClientCommandManager.argument("port", IntegerArgumentType.integer(1024, 65535))
                        .executes(context -> {
                            int port = IntegerArgumentType.getInteger(context, "port");
                            setPort(context.getSource(), port);
                            return 1;
                        })
                    )
                    .executes(context -> {
                        showPort(context.getSource());
                        return 1;
                    })
                )
                .then(ClientCommandManager.literal("reconnect")
                    .executes(context -> {
                        reconnect(context.getSource());
                        return 1;
                    })
                )
        );
    }
    
    private static void showStatus(FabricClientCommandSource source) {
        DiscordWebSocketServer server = DiscordWebSocketServer.getInstance();
        
        StringBuilder status = new StringBuilder();
        status.append("§6=== Discord Chat Integration Status ===§r\n");
        
        if (server == null) {
            status.append("§cServer: Not initialized§r\n");
            status.append("§7Warning: Port may be taken or server failed to start§r\n");
            status.append("§7Use §f/discordchat port <number>§7 to change to a different port§r");
        } else if (server.isRunning()) {
            status.append("§aServer: Running§r\n");
            status.append(String.format("§7Port: §f%d§r\n", server.getPort()));
            status.append(String.format("§7Connected clients: §f%d§r", server.getConnectionCount()));
        } else {
            status.append("§cServer: Stopped§r\n");
            status.append("§7Warning: Port may be taken or server is offline§r\n");
            status.append("§7Use §f/discordchat port <number>§7 to change to a different port§r");
        }
        
        source.sendFeedback(Component.literal(status.toString()));
    }
    
    private static void showPort(FabricClientCommandSource source) {
        int currentPort = ModConfig.getInstance().getPort();
        source.sendFeedback(Component.literal(
            String.format("§6Current WebSocket port: §f%d§r\n§7Use §f/discordchat port <number>§7 to change it.", currentPort)
        ));
    }
    
    private static void setPort(FabricClientCommandSource source, int port) {
        ModConfig config = ModConfig.getInstance();
        int oldPort = config.getPort();
        
        config.setPort(port);
        config.save();
        
        source.sendFeedback(Component.literal(
            String.format("§aPort changed from §f%d§a to §f%d§r\n§7Use §f/discordchat reconnect§7 to apply changes.", oldPort, port)
        ));
    }
    
    private static void reconnect(FabricClientCommandSource source) {
        source.sendFeedback(Component.literal("§6Restarting WebSocket server...§r"));
        
        DiscordWebSocketServer oldServer = DiscordWebSocketServer.getInstance();
        if (oldServer != null && oldServer.isRunning()) {
            oldServer.stopServer();
        }
        
        int port = ModConfig.getInstance().getPort();
        DiscordWebSocketServer.createInstance(port);
        DiscordWebSocketServer newServer = DiscordWebSocketServer.getInstance();
        
        // Set up message handler
        newServer.setMessageHandler(message -> {
            discord.chat.mc.chat.ChatHandler.getInstance().handleDiscordMessage(message);
        });
        
        // Start in a new thread
        new Thread(() -> {
            try {
                newServer.start();
                source.sendFeedback(Component.literal(
                    String.format("§aWebSocket server restarted on port §f%d§r", port)
                ));
            } catch (Exception e) {
                source.sendError(Component.literal(
                    String.format("§cFailed to start server: %s§r", e.getMessage())
                ));
            }
        }, "Discord-WebSocket-Server").start();
    }
}

