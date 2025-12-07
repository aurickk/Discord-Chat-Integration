# External [Vencord](https://vencord.dev/) Plugin Installation Guide

> [!WARNING]
> The "Forward to Discord" feature (which automatically sends Minecraft chat messages to Discord channels) may be considered **self-botting** and could violate Discord's Terms of Service. Using automated message sending features in public Discord servers may result in account action. It is highly recommend to create a new **private** Discord server dedicated and configured to the plugin.

Because this is not an official Vencord plugin, you must build Vencord with the plugin from source before injecting Discord.

1. Install [Node.js](https://nodejs.org/en), [git](https://git-scm.com/install/), and [pnpm](https://pnpm.io/installation) if missing.

2. Clone Vencord's Github repository:
```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install --frozen-lockfile
```
3. Navigate to the `src` folder in the cloned Vencord repository, create a new folder called `userplugins` if it dosen't already exist.

3. Download `minecraftChat.tsx` from the latest [release](https://github.com/aurickk/Discord-Chat-Integration/releases) and move it to the `userplugins` folder.

4. Build Vencord and inject Discord:

```sh
pnpm build
pnpm inject
```
5. If built and injected successfully, follow the remaining prompt(s) and restart Discord to apply changes.
6. In Discord's Vencord plugins menu, enable the MinecraftChat Plugin.

[Offical Vencord custom plugin installation documentation](https://docs.vencord.dev/installing/custom-plugins/)

