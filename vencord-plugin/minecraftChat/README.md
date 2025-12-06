# External Vencord Plugin Installation Guide

Because this is not an official Vencord plugin, you must rebuild and inject Discord with the plugin.
> [!WARNING]
> The "Forward to Discord" feature (which automatically sends Minecraft chat messages to Discord channels) may be considered **self-botting** and could violate Discord's Terms of Service. Using automated message sending features in public Discord servers may result in account action.

Because this is not an official Vencord plugin, you must build Vencord with the plugin from source before install Vencord.

1. Install [Node.js](https://nodejs.org/en), [git](https://git-scm.com/install/), and [pnpm](https://pnpm.io/installation) if missing.

2. Clone Vencord's Github repository:
```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install --frozen-lockfile
```

3. Create a folder called `minecraftChat` in `[Where-You-Cloned-Your-Vencord-Repository]/Vencord/src/plugins`.


4. Download `index.tsx` from the latest [release](https://github.com/aurickk/Discord-Chat-Integration/releases) and move it into the newly created `minecraftChat` folder.

5. Run:
```sh
pnpm build
pnpm inject
```
6. If built and injected successfully, follow the remaining prompt(s) and restart Discord to apply changes.
7. In Discord's Vencord plugins menu, enable the MinecraftChat Plugin.

