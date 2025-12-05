package discord.chat.mc;

import discord.chat.mc.chat.ChatHandler;
import discord.chat.mc.command.DiscordCommand;
import discord.chat.mc.config.ModConfig;
import discord.chat.mc.websocket.DiscordWebSocketServer;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;

import java.net.BindException;

public class DiscordChatIntegrationClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		DiscordChatIntegration.LOGGER.info("Initializing Discord Chat Integration client...");
		
		// Load config
		ModConfig config = ModConfig.getInstance();
		
		// Register commands
		DiscordCommand.register();
		
		// Start WebSocket server when client is ready
		ClientLifecycleEvents.CLIENT_STARTED.register(client -> {
			startWebSocketServer(config.getPort());
		});
		
		// Stop WebSocket server when client stops
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
			stopWebSocketServer();
			// Shutdown ChatHandler thread pools
			ChatHandler.getInstance().shutdown();
		});
		
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
			showStatusOnJoin();
		});
		
		DiscordChatIntegration.LOGGER.info("Discord Chat Integration client initialized!");
	}
	
	private void showStatusOnJoin() {
		Minecraft client = Minecraft.getInstance();
		if (client == null || client.player == null) {
			return;
		}
		
		// Delay to ensure player is fully loaded
			client.execute(() -> {
				client.execute(() -> {
					DiscordWebSocketServer server = DiscordWebSocketServer.getInstance();
					if (server != null && server.isRunning() && server.getConnectionCount() > 0) {
						String status = String.format(
							"§6[Discord Chat] §7Status: §aConnected§7 | Port: §f%d§7 | Clients: §f%d",
							server.getPort(),
							server.getConnectionCount()
						);
						client.player.displayClientMessage(Component.literal(status), false);
					} else {
						ModConfig config = ModConfig.getInstance();
						client.player.displayClientMessage(
							Component.literal("§6[Discord Chat] §7Status: §cDisconnected"),
							false
						);
						client.player.displayClientMessage(
							Component.literal(String.format("§7Warning: Client(s) may be offline or port §f%d§7 may be taken", config.getPort())),
							false
						);
						client.player.displayClientMessage(
							Component.literal("§7Use §f/discordchat port <number>§7 to change to a different port"),
							false
						);
					}
				});
			});
	}
	
	private void startWebSocketServer(int port) {
		DiscordWebSocketServer.createInstance(port);
		DiscordWebSocketServer server = DiscordWebSocketServer.getInstance();
		
		// Set up message handler to process Discord messages
		server.setMessageHandler(message -> {
			ChatHandler.getInstance().handleDiscordMessage(message);
		});
		
		// Start server in a separate thread
		new Thread(() -> {
			try {
				server.start();
				// Wait for server to initialize
				int attempts = 0;
				while (!server.isRunning() && attempts < 10) {
					Thread.sleep(50);
					attempts++;
				}
				if (server.isRunning()) {
					DiscordChatIntegration.LOGGER.info("WebSocket server started successfully on port {}", port);
				} else {
					throw new RuntimeException("Server failed to start - not running after start() call");
				}
			} catch (Exception e) {
				String errorMsg = e.getMessage() != null ? e.getMessage() : "";
				boolean isBindError = e instanceof BindException || 
				                     e.getCause() instanceof BindException ||
				                     errorMsg.contains("Address already in use") || 
				                     errorMsg.contains("BindException") || 
				                     errorMsg.contains("already bound");
				
				if (isBindError) {
					DiscordChatIntegration.LOGGER.error("Port {} is already in use. Server failed to start.", port);
					showPortError(port);
				} else {
					DiscordChatIntegration.LOGGER.error("Failed to start WebSocket server on port {}: {}", port, e.getMessage());
					if (e.getCause() != null) {
						DiscordChatIntegration.LOGGER.error("Caused by: {}", e.getCause().getMessage());
					}
					showGenericError();
					e.printStackTrace();
				}
			}
		}, "Discord-WebSocket-Server").start();
	}
	
	private void stopWebSocketServer() {
		DiscordWebSocketServer server = DiscordWebSocketServer.getInstance();
		if (server != null && server.isRunning()) {
			server.stopServer();
		}
	}
	
	private void showPortError(int port) {
					Minecraft client = Minecraft.getInstance();
					if (client != null) {
						client.execute(() -> {
							if (client.player != null) {
								client.player.displayClientMessage(
									Component.literal(String.format("§c[Discord Chat] §7Warning: Port %d is already in use!", port)),
									false
								);
								client.player.displayClientMessage(
									Component.literal("§7Use §f/discordchat port <number>§7 to change to a different port"),
									false
								);
							}
						});
					}
					}
					
	private void showGenericError() {
					Minecraft client = Minecraft.getInstance();
					if (client != null) {
						client.execute(() -> {
							if (client.player != null) {
								client.player.displayClientMessage(
									Component.literal("§c[Discord Chat] §7Failed to start server. Check logs for details."),
									false
								);
							}
						});
		}
	}
}