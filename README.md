<p align="center"><img src="./app/assets/images/logo.svg" width="120px" alt="BTD"></p>

<h1 align="center">BTD Minecraft Launcher</h1>

Launcher for the Business To Do Minecraft server. It installs Java, Minecraft, Fabric and the modpack, keeps them up to date and joins the server automatically.

Based on [HeliosLauncher](https://github.com/dscalzi/HeliosLauncher) by Daniel Scalzi (see `LICENSE.txt`).

---

## Development

Requires [Node.js](https://nodejs.org/) 22+.

```console
npm install
npm start
```

IntelliJ run configurations (`.idea/runConfigurations`):

| Configuration | What it does |
|---|---|
| **Launcher** | Starts the launcher in development mode (`npm start`). |
| **Distro - generate from modpack** | Builds the server list from a `.mrpack` (`npm run distro`). |

In development mode the launcher never updates itself, and it always loads the server list from the web server.

---

## Files on the web server

The website (BTD GameCollection, running on the Raspberry Pi) serves everything in its folder **`data/minecraft/`** at **`https://business-to-do.com/minecraft/`**. The folder sits inside the website directory, next to `btd_gamecollection.db`; the website creates it on start, and deploys don't touch it. The files get there through the [automatic deployment](#automatic-deployment) (or by hand, e.g. with `scp`); they are not part of the website's Git repository.

```
<website directory>/data/minecraft/
├── distribution.json                         server list: server, Fabric, mods
├── versions/
│   └── fabric-loader-<loader>-<mc>.json      Fabric version file (referenced by distribution.json)
└── launcher/
    ├── latest.yml                            tells installed launchers which version is current
    ├── BTD-Launcher-setup-<version>.exe      installer (also the download for new players)
    └── BTD-Launcher-setup-<version>.exe.blockmap   lets updates download only the changed parts
```

| From this project | Upload to (on the Pi) | Public URL |
|---|---|---|
| `distro/output/distribution.json` | `data/minecraft/distribution.json` | `/minecraft/distribution.json` |
| `distro/output/versions/*.json` | `data/minecraft/versions/` | `/minecraft/versions/…` |
| `dist/BTD-Launcher-setup-<version>.exe` | `data/minecraft/launcher/` | `/minecraft/launcher/…` |
| `dist/BTD-Launcher-setup-<version>.exe.blockmap` | `data/minecraft/launcher/` | `/minecraft/launcher/…` |
| `dist/latest.yml` | `data/minecraft/launcher/` — **always last** | `/minecraft/launcher/latest.yml` |

Example with `scp` from this project folder (replace the login and website directory with yours):

```console
scp distro\output\distribution.json pi@raspberrypi.local:~/BTD_GameCollection/data/minecraft/
scp distro\output\versions\*.json pi@raspberrypi.local:~/BTD_GameCollection/data/minecraft/versions/
```

These addresses are built into the launcher. If they ever change, update all of:

| Setting | File |
|---|---|
| Server list URL (`DISTRO_URL`) | `app/assets/js/hosting.js` |
| Update folder (`publish.url`) | `electron-builder.yml` (baked into the installer at build time) |
| Update folder for the Mac download link (`LAUNCHER_UPDATE_URL`) | `app/assets/js/hosting.js` |
| Base URL for the Fabric version file (`baseUrl`) | `distro/config.json` |

> Launchers that are already installed keep checking the update folder that was baked into **their** installer. Moving the update folder therefore needs one last update from the old location.

---

## Automatic deployment

Deployment is **pull-only**: GitHub builds the files and publishes them, and the Raspberry Pi fetches them. Nothing connects to the Pi.

1. Every push to `master` runs the **Deploy** workflow (`.github/workflows/deploy.yml`) on GitHub's machines:

   | Part | Built when | Built on |
   |---|---|---|
   | Server list (`distribution.json` + `versions/`) | always, from `distro/modpack.mrpack` + `distro/config.json`; **published only if it differs** from the released one | Linux |
   | Launcher (`.exe`, `.blockmap`, `latest.yml`) | the version in `package.json` differs from the released one | Windows |

   The results go into the release **`deploy`** of this repository (*Releases*), together with a `manifest.json` that lists every file with its checksum. Pushes that change neither part publish nothing. *Actions → Deploy → Run workflow* starts it by hand; tick *force* to rebuild both.
2. The Pi's deploy script runs `bun scripts/pull-minecraft.ts` in the website directory (BTD GameCollection). It reads the manifest and downloads only the files whose checksum differs into `data/minecraft/`, the installer before `latest.yml`, each one swapped in whole.

So a change is live after the workflow finishes **and** the Pi's deploy script has run next.

### One-time setup

1. **Modpack:** commit your export as `distro/modpack.mrpack` (the only `.mrpack` Git doesn't ignore).
2. **Token for the Pi:** on GitHub, *Settings (of your account) → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*:
   - *Repository access:* **Only select repositories** → this repository
   - *Permissions:* **Contents: Read-only** (nothing else)
   - Note the expiry date; renew the token before it runs out.
3. **On the Pi**, add to the website's `.env`:

   ```
   MINECRAFT_DEPLOY_REPO=philipp-frzk/BTD_MC_Launcher
   MINECRAFT_DEPLOY_TOKEN=github_pat_...
   ```

   and add this line at the end of the deploy script (outside the `if`, so it runs on every run):

   ```bash
   bun scripts/pull-minecraft.ts
   ```

The token can only read this repository; even if it leaks, nobody can push or reach the Pi with it.

---

## Shipping modpack and server changes

Use this for new or updated mods, a new Minecraft or Fabric version, or changes to the server address, name, description or paid-until date. **No launcher update is needed** — players get the changes the next time they press *Spielen*.

1. **Modpack (if it changed):** make the changes in the Modrinth App and test them. Then export the profile (*⋮ → Export modpack*) and save it over **`distro/modpack.mrpack`**.
2. **Server details (if they changed):** edit `distro/config.json` (for a quick `paidUntil` change, editing it directly on GitHub works too):

   ```json
   {
       "baseUrl": "https://business-to-do.com/minecraft/",
       "server": {
           "id": "btd",
           "name": "Business To Do Minecraft Vanilla",
           "description": "Vanilla+ Survival. ...",
           "address": "<g-portal ip>:<port>",
           "paidUntil": "2026-12-31",
           "autoconnect": true
       }
   }
   ```

   | Field | Meaning |
   |---|---|
   | `id` | Keep it the same. Changing it gives every player a fresh game folder (settings, worlds and screenshots stay behind in the old one). |
   | `name` / `description` | Title and tagline on the launcher's main page. |
   | `address` | Used for the online status, the player count and auto-join. |
   | `paidUntil` | Last paid day (`YYYY-MM-DD`). Shown as "noch X Tage" in the server pill; remove it to hide the countdown. |

3. **Test locally (optional):** run **Distro - generate from modpack** (or `npm run distro`). It uses `distro/modpack.mrpack`, prints the Minecraft and Fabric versions and the mods, checks that the server answers and opens `distro/output/`. Server-only mods are left out (install those on G-Portal).
4. **Commit and push.** The Deploy workflow generates and publishes the server list; the Pi picks it up on its next deploy run.
5. **Check:** open `https://business-to-do.com/minecraft/distribution.json` in the browser. The server status and Serverkasse on the website pick up the new file within 5 minutes.

Without the workflow: run step 3 and upload the contents of `distro/output/` into `data/minecraft/` on the Pi, keeping the folders (see [Files on the web server](#files-on-the-web-server)).

Also update the G-Portal server whenever the Minecraft version, Fabric Loader or server-side mods change.

---

## Shipping a new launcher version

Use this for changes to the launcher itself (design, features, fixes). Installed launchers download the update in the background and turn *Spielen* into **UPDATE**; it is also installed when the launcher is closed.

1. **Raise the version** in `package.json`, e.g. `1.0.0` → `1.0.1`. Installed launchers only update to a *higher* version.
2. **Commit and push.** The Deploy workflow sees the new version, builds the installer on Windows (roughly 10 minutes) and publishes it; the Pi picks it up on its next deploy run (`latest.yml` last).
3. **Check:** `https://business-to-do.com/minecraft/launcher/latest.yml` shows the new version, and the download page `https://business-to-do.com/minecraft/launcher` offers it. An installed launcher picks it up within 30 minutes or on its next start.
4. **Clean up (optional):** older installers in `data/minecraft/launcher/` can be deleted once everyone has updated. Keep the current one — the download page links to it.

Code changes pushed *without* a version bump are not deployed.

### Building and uploading by hand

1. **Build:**

   ```console
   npm run dist
   ```

   This creates in `dist/`:

   | File | Upload? |
   |---|---|
   | `BTD-Launcher-setup-1.0.1.exe` | yes |
   | `BTD-Launcher-setup-1.0.1.exe.blockmap` | yes |
   | `latest.yml` | yes — **last** |
   | `win-unpacked/` | no (the unpacked app, for testing: `win-unpacked/BTD Launcher.exe`) |

2. **Upload** into `data/minecraft/launcher/` on the Pi: first the `.exe` and `.blockmap`, **then** `latest.yml`. If `latest.yml` arrives first, launchers may look for an installer that isn't there yet.

   ```console
   scp dist\BTD-Launcher-setup-1.0.1.exe dist\BTD-Launcher-setup-1.0.1.exe.blockmap pi@raspberrypi.local:~/BTD_GameCollection/data/minecraft/launcher/
   scp dist\latest.yml pi@raspberrypi.local:~/BTD_GameCollection/data/minecraft/launcher/
   ```

---

## First install for new players

Send them the download page: **`https://business-to-do.com/minecraft/launcher`**. It always offers the current installer (it reads `latest.yml`) and explains the install steps.

- The installer isn't code-signed, so Windows shows *"Windows hat Ihren PC geschützt"* → **Weitere Informationen → Trotzdem ausführen**.
- It installs per user (no admin rights needed) to `%LOCALAPPDATA%\Programs\`. Game files and settings are stored in `%APPDATA%\BTD Launcher`.
- On the first start they sign in with Microsoft; the launcher then downloads Java, Minecraft and the mods.

---

## Microsoft login

The Microsoft app ID is set in `app/assets/js/ipcconstants.js` (`AZURE_CLIENT_ID`). Registering your own ID is described in [docs/MicrosoftAuth.md](docs/MicrosoftAuth.md). After switching IDs, every player has to sign in again once.
