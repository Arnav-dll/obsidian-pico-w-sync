# Obsidian Pico W Vault Sync

An Obsidian plugin that seamlessly synchronizes and clones your vaults with a self-hosted Raspberry Pi Pico W SD Card server over local Wi-Fi.

---

## Features

- **Quick Sync (`Pico W: Quick Sync (< 128KB)`)**: High-speed synchronization designed for markdown notes, small configs, and canvas files. Automatically skips large media files (configurable in settings, default 128 KB) to minimize Wi-Fi transfer times over microcontrollers.
- **Full Sync (`Pico W: Sync Vault (Full)`)**: Comprehensive two-way sync for all files in the vault.
- **Sync History Tracking**: Tracks modification state and file sizes locally to avoid unnecessary re-uploads and eliminate infinite re-sync loops.
- **Automatic Vault-Name Matching**: By default, syncs to a folder on your Pico W SD card matching your active vault name.
- **Pico W Clone (`Pico W: Clone Vault`)**: Clone an entire remote vault to a new device or an empty vault in a single click from the Command Palette.
- **Cross-Platform**: Built using Obsidian's native `requestUrl` and binary vault APIs, fully compatible with desktop and mobile.
- **Basic Authentication**: Supports HTTP Basic Authentication header to secure file endpoints.

---

## How It Works

```
+------------------+         Local Wi-Fi          +------------------------+
|  Obsidian Vault  |  <========================>  | Raspberry Pi Pico W    |
| (Desktop/Mobile) |    HTTP (GET, PUT, JSON)     | + SD Card (FAT32)      |
+------------------+                              +------------------------+
```

### Server Endpoints Expected on Pico W
The Pico W MicroPython server exposes three endpoints:
1. `GET /?dir=<path>`: Returns JSON listing of directory contents:
   ```json
   {
     "directory": "/<path>",
     "contents": [
       { "name": "Folder", "type": "dir", "mtime": 1700000000, "size": 0 },
       { "name": "note.md", "type": "file", "mtime": 1700000000, "size": 1234 }
     ]
   }
   ```
2. `PUT /upload/<path>`: Receives raw binary data in request body to save a file. Automatically creates parent directories.
3. `GET /download/<path>`: Returns raw binary file contents.

---

## Installation

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Navigate to your vault's plugin directory:
   `<VaultFolder>/.obsidian/plugins/`
3. Create a folder named `pico-w-sync` and place the files inside.
4. In Obsidian, go to **Settings > Community Plugins**, toggle **Restricted Mode** off, and enable **Pico W Vault Sync**.

---

## Configuration

In Obsidian, go to **Settings > Pico W Vault Sync**:

| Setting | Description | Example / Placeholder |
| :--- | :--- | :--- |
| **Pico W IP Address** | The local IP assigned to your Raspberry Pi Pico W. | `192.168.1.100` |
| **Credentials (Base64)** | Base64-encoded `username:password` string for Basic Auth. | `YWRtaW46cGFzc3dvcmQ=` |
| **Remote Vault Folder** | Folder on SD card. Leave blank to match your local vault name. | `(Vault Name)` |
| **Quick Sync Size Limit (KB)** | Maximum file size in KB for Quick Sync. | `128` |

> **Tip:** You can generate your Base64 auth string in browser devtools or terminal:
> ```javascript
> btoa("your_username:your_password")
> ```

---

## Commands

Press `Ctrl + P` (or `Cmd + P` on macOS) to open the Command Palette:

1. **`Pico W: Quick Sync (< 128KB)`** (`pico-w-quick-sync`):
   - Fast synchronization of notes and small files (< 128KB), skipping heavy media.
2. **`Pico W: Sync Vault (Full)`** (`sync-to-pico-w`):
   - Compares local files against the remote vault folder.
   - Synchronizes modified files and downloads newly added remote files.
3. **`Pico W: Clone Vault`** (`pico-w-clone`):
   - Lists available vault folders on the Pico W SD card.
   - Lets you choose a vault (or clones immediately if only one exists).
   - Recursively downloads all files and creates local folders.

---

## Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/)

### Steps
1. Clone the repository:
   ```bash
   git clone https://github.com/your-username/obsidian-pico-w-sync.git
   cd obsidian-pico-w-sync
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build for production:
   ```bash
   npm run build
   ```
   This compiles `src/main.ts` into `main.js`.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
