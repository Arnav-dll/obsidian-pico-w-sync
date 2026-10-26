import { App, FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, requestUrl, TFile } from 'obsidian';

interface PicoSyncSettings {
    picoIp: string;
    authStr: string; // Base64 encoded "username:password"
    vaultFolder: string;
    quickSyncMaxKb: number; // Max size in KB for quick sync (default 128)
    syncHistory: Record<string, { localMtime: number; remoteMtime: number; size: number }>;
}

const DEFAULT_SETTINGS: PicoSyncSettings = {
    picoIp: '192.168.1.100', // Example placeholder IP
    authStr: '',             // Base64 encoded credentials e.g. btoa("username:password")
    vaultFolder: '',         // Leave empty to automatically use vault name
    quickSyncMaxKb: 128,     // 128 KB
    syncHistory: {}
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface RemoteFileInfo {
    path: string;       // Full remote path, e.g. "MyVault/note.md"
    mtime: number;
    size: number;
}

export default class PicoSyncPlugin extends Plugin {
    settings!: PicoSyncSettings;

    async onload() {
        await this.loadSettings();

        // 1. Quick Sync command (default < 128KB)
        this.addCommand({
            id: 'pico-w-quick-sync',
            name: `Pico W: Quick Sync (< ${this.settings.quickSyncMaxKb || 128}KB)`,
            callback: () => {
                this.runSync(true);
            }
        });

        // 2. Full Sync Vault command
        this.addCommand({
            id: 'sync-to-pico-w',
            name: 'Pico W: Sync Vault (Full)',
            callback: () => {
                this.runSync(false);
            }
        });

        // 3. Clone / Import Vault command
        this.addCommand({
            id: 'pico-w-clone',
            name: 'Pico W: Clone Vault',
            callback: () => {
                this.runClone();
            }
        });

        // Add Settings UI
        this.addSettingTab(new PicoSyncSettingTab(this.app, this));
    }

    getVaultFolder(): string {
        const custom = this.settings.vaultFolder?.trim();
        return custom ? custom : this.app.vault.getName();
    }

    async runSync(isQuickSync: boolean = false) {
        if (!this.settings.picoIp || !this.settings.authStr) {
            new Notice('Please configure your Pico W IP and credentials in plugin settings.');
            return;
        }

        const maxBytes = isQuickSync ? (this.settings.quickSyncMaxKb || 128) * 1024 : Infinity;
        const syncLabel = isQuickSync ? `Quick Sync (< ${this.settings.quickSyncMaxKb || 128}KB)` : 'Full Sync';

        new Notice(`Pico W ${syncLabel} Started...`);
        try {
            const vaultFolder = this.getVaultFolder();
            const localFiles = this.app.vault.getFiles();

            // Fetch remote files metadata recursively
            const remoteFiles = await this.listRemoteFilesRecursively(vaultFolder);
            const remoteFileMap = new Map<string, RemoteFileInfo>();
            for (const rf of remoteFiles) {
                const relPath = rf.path.startsWith(`${vaultFolder}/`)
                    ? rf.path.substring(vaultFolder.length + 1)
                    : rf.path;
                remoteFileMap.set(relPath, rf);
            }

            let uploaded = 0;
            let downloaded = 0;
            let skippedLarge = 0;

            if (!this.settings.syncHistory) {
                this.settings.syncHistory = {};
            }

            // 1. Process local files
            for (const file of localFiles) {
                // If quick sync, skip files exceeding the size threshold
                if (file.stat.size > maxBytes) {
                    skippedLarge++;
                    remoteFileMap.delete(file.path);
                    continue;
                }

                const localMtimeSec = Math.floor(file.stat.mtime / 1000);
                const remotePath = `${vaultFolder}/${file.path}`;
                const remoteEntry = remoteFileMap.get(file.path);
                const lastSync = this.settings.syncHistory[file.path];

                if (!remoteEntry) {
                    // Local file not on remote -> Upload
                    await this.uploadFile(file, remotePath);
                    await sleep(150); // Give SD card controller time to write FAT table
                    uploaded++;
                    this.settings.syncHistory[file.path] = {
                        localMtime: localMtimeSec,
                        remoteMtime: localMtimeSec,
                        size: file.stat.size
                    };
                } else {
                    const remoteMtimeSec = remoteEntry.mtime;

                    // Determine what actually changed
                    const localChanged = !lastSync ||
                        Math.abs(localMtimeSec - lastSync.localMtime) > 2 ||
                        file.stat.size !== lastSync.size;

                    const remoteChanged = !lastSync ||
                        Math.abs(remoteMtimeSec - lastSync.remoteMtime) > 2 ||
                        remoteEntry.size !== lastSync.size;

                    if (localChanged && !remoteChanged) {
                        // Only local was modified -> Upload
                        await this.uploadFile(file, remotePath);
                        await sleep(150); // Give SD card controller time to write FAT table
                        uploaded++;
                        this.settings.syncHistory[file.path] = {
                            localMtime: localMtimeSec,
                            remoteMtime: remoteMtimeSec,
                            size: file.stat.size
                        };
                    } else if (remoteChanged && !localChanged) {
                        // Only remote was modified -> Download
                        await this.saveRemoteFileToVault(file.path, remotePath);
                        downloaded++;
                        const updatedLocal = this.app.vault.getAbstractFileByPath(file.path);
                        const newLocalMtime = updatedLocal instanceof TFile ? Math.floor(updatedLocal.stat.mtime / 1000) : localMtimeSec;
                        this.settings.syncHistory[file.path] = {
                            localMtime: newLocalMtime,
                            remoteMtime: remoteMtimeSec,
                            size: remoteEntry.size
                        };
                    } else if (localChanged && remoteChanged) {
                        // Both changed (or first sync): fallback to latest timestamp
                        if (localMtimeSec > remoteMtimeSec + 2) {
                            await this.uploadFile(file, remotePath);
                            await sleep(150); // Give SD card controller time to write FAT table
                            uploaded++;
                            this.settings.syncHistory[file.path] = {
                                localMtime: localMtimeSec,
                                remoteMtime: remoteMtimeSec,
                                size: file.stat.size
                            };
                        } else if (remoteMtimeSec > localMtimeSec + 2) {
                            await this.saveRemoteFileToVault(file.path, remotePath);
                            downloaded++;
                            const updatedLocal = this.app.vault.getAbstractFileByPath(file.path);
                            const newLocalMtime = updatedLocal instanceof TFile ? Math.floor(updatedLocal.stat.mtime / 1000) : localMtimeSec;
                            this.settings.syncHistory[file.path] = {
                                localMtime: newLocalMtime,
                                remoteMtime: remoteMtimeSec,
                                size: remoteEntry.size
                            };
                        } else {
                            // Already in sync
                            this.settings.syncHistory[file.path] = {
                                localMtime: localMtimeSec,
                                remoteMtime: remoteMtimeSec,
                                size: file.stat.size
                            };
                        }
                    }
                    remoteFileMap.delete(file.path);
                }
            }

            // 2. Download any files that exist on remote but not locally
            for (const [relPath, remoteEntry] of remoteFileMap.entries()) {
                if (relPath.startsWith('.obsidian')) continue;

                if (remoteEntry.size > maxBytes) {
                    skippedLarge++;
                    continue;
                }

                await this.saveRemoteFileToVault(relPath, remoteEntry.path);
                downloaded++;
                const createdFile = this.app.vault.getAbstractFileByPath(relPath);
                const createdMtime = createdFile instanceof TFile ? Math.floor(createdFile.stat.mtime / 1000) : remoteEntry.mtime;
                this.settings.syncHistory[relPath] = {
                    localMtime: createdMtime,
                    remoteMtime: remoteEntry.mtime,
                    size: remoteEntry.size
                };
            }

            await this.saveSettings();

            const skipMsg = isQuickSync && skippedLarge > 0 ? ` | Skipped > ${this.settings.quickSyncMaxKb}KB: ${skippedLarge}` : '';
            new Notice(`${syncLabel} Complete! Uploaded: ${uploaded} | Downloaded: ${downloaded}${skipMsg}`);
        } catch (error) {
            console.error('Pico W Sync Error:', error);
            new Notice('Sync Failed. Check console and Pico W connection.');
        }
    }

    async runClone() {
        if (!this.settings.picoIp || !this.settings.authStr) {
            new Notice('Please configure your Pico W IP and credentials in plugin settings.');
            return;
        }

        const notice = new Notice('Pico W Clone: Connecting to Pico W...', 0);
        try {
            const rootUrl = encodeURI(`http://${this.settings.picoIp}/?dir=`);
            const res = await requestUrl({
                url: rootUrl,
                headers: {
                    'Authorization': `Basic ${this.settings.authStr}`,
                    'Accept': 'application/json'
                }
            });

            notice.hide();

            if (res.status !== 200 || !res.json || !Array.isArray(res.json.contents)) {
                new Notice('Failed to list vaults from Pico W.');
                return;
            }

            // Identify all directories on the Pico W root
            const dirs: string[] = res.json.contents
                .filter((item: any) => item.type === 'dir')
                .map((item: any) => item.name);

            if (dirs.length === 0) {
                new Notice('No vault folders found on Pico W SD card.');
                return;
            }

            // Prioritize current vault folder in the list
            const currentVault = this.getVaultFolder();
            dirs.sort((a, b) => {
                if (a === currentVault) return -1;
                if (b === currentVault) return 1;
                return a.localeCompare(b);
            });

            const firstDir = dirs[0];
            if (dirs.length === 1 && firstDir) {
                await this.cloneVault(firstDir);
            } else {
                new VaultSelectModal(this.app, dirs, async (selectedVault) => {
                    await this.cloneVault(selectedVault);
                }).open();
            }
        } catch (error) {
            notice.hide();
            console.error('Pico W Clone Error:', error);
            new Notice('Pico W Clone Failed. Check connection to Pico W.');
        }
    }

    async cloneVault(remoteVaultFolder: string) {
        const notice = new Notice(`Pico W: Cloning vault '${remoteVaultFolder}'...`, 0);
        try {
            const remoteFiles = await this.listRemoteFilesRecursively(remoteVaultFolder);
            if (remoteFiles.length === 0) {
                notice.hide();
                new Notice(`Pico W Clone: Remote folder '${remoteVaultFolder}' is empty.`);
                return;
            }

            if (!this.settings.syncHistory) {
                this.settings.syncHistory = {};
            }

            let imported = 0;
            for (const rf of remoteFiles) {
                const localPath = rf.path.startsWith(`${remoteVaultFolder}/`)
                    ? rf.path.substring(remoteVaultFolder.length + 1)
                    : rf.path;

                if (!localPath || localPath.startsWith('.obsidian')) continue;

                await this.saveRemoteFileToVault(localPath, rf.path);
                imported++;

                const importedFile = this.app.vault.getAbstractFileByPath(localPath);
                const localMtime = importedFile instanceof TFile ? Math.floor(importedFile.stat.mtime / 1000) : rf.mtime;
                this.settings.syncHistory[localPath] = {
                    localMtime: localMtime,
                    remoteMtime: rf.mtime,
                    size: rf.size
                };
            }

            await this.saveSettings();
            notice.hide();
            new Notice(`Pico W Clone Complete! Successfully imported ${imported} file(s) from '${remoteVaultFolder}'.`);
        } catch (error) {
            notice.hide();
            console.error('Pico W Clone Import Error:', error);
            new Notice(`Failed to clone vault '${remoteVaultFolder}'. Check console.`);
        }
    }

    async listRemoteFilesRecursively(dirPath: string): Promise<RemoteFileInfo[]> {
        const url = encodeURI(`http://${this.settings.picoIp}/?dir=${dirPath}`);
        const results: RemoteFileInfo[] = [];

        try {
            const res = await requestUrl({
                url: url,
                headers: {
                    'Authorization': `Basic ${this.settings.authStr}`,
                    'Accept': 'application/json'
                }
            });

            if (res.status === 200 && res.json && Array.isArray(res.json.contents)) {
                for (const item of res.json.contents) {
                    const fullPath = dirPath ? `${dirPath}/${item.name}` : item.name;
                    if (item.type === 'dir') {
                        const subFiles = await this.listRemoteFilesRecursively(fullPath);
                        results.push(...subFiles);
                    } else {
                        results.push({
                            path: fullPath,
                            mtime: item.mtime || 0,
                            size: item.size || 0
                        });
                    }
                }
            }
        } catch (e) {
            // Folder may not exist on remote yet
        }

        return results;
    }

    async ensureDirectoryExists(filePath: string) {
        const lastSlash = filePath.lastIndexOf('/');
        if (lastSlash === -1) return;
        const dirPath = filePath.substring(0, lastSlash);
        const parts = dirPath.split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const existing = this.app.vault.getAbstractFileByPath(current);
            if (!existing) {
                try {
                    await this.app.vault.createFolder(current);
                } catch (e) {
                    // Ignore if folder exists or was created in parallel
                }
            }
        }
    }

    async uploadFile(file: TFile, remotePath: string) {
        const fileData = await this.app.vault.readBinary(file); 
        const url = encodeURI(`http://${this.settings.picoIp}/upload/${remotePath}`);
        
        await requestUrl({
            url: url,
            method: 'PUT',
            headers: {
                'Authorization': `Basic ${this.settings.authStr}`,
                'Content-Type': 'application/octet-stream',
                'Connection': 'close'
            },
            body: fileData
        });
    }

    async saveRemoteFileToVault(localPath: string, remotePath: string) {
        await this.ensureDirectoryExists(localPath);
        const url = encodeURI(`http://${this.settings.picoIp}/download/${remotePath}`);
        
        const res = await requestUrl({
            url: url,
            method: 'GET',
            headers: { 'Authorization': `Basic ${this.settings.authStr}` }
        });

        if (res.status === 200) {
            const existing = this.app.vault.getAbstractFileByPath(localPath);
            if (existing instanceof TFile) {
                await this.app.vault.modifyBinary(existing, res.arrayBuffer);
            } else if (!existing) {
                await this.app.vault.createBinary(localPath, res.arrayBuffer);
            }
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if (!this.settings.syncHistory) {
            this.settings.syncHistory = {};
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class VaultSelectModal extends FuzzySuggestModal<string> {
    folders: string[];
    onChoose: (folder: string) => void;

    constructor(app: App, folders: string[], onChoose: (folder: string) => void) {
        super(app);
        this.folders = folders;
        this.onChoose = onChoose;
        this.setPlaceholder('Select a vault to clone from Pico W...');
    }

    getItems(): string[] {
        return this.folders;
    }

    getItemText(item: string): string {
        return item;
    }

    onChooseItem(item: string, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}

class PicoSyncSettingTab extends PluginSettingTab {
    plugin: PicoSyncPlugin;

    constructor(app: App, plugin: PicoSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();
        containerEl.createEl('h2', {text: 'Pico W Sync Settings'});

        new Setting(containerEl)
            .setName('Pico W IP Address')
            .setDesc('Local IP address of your Raspberry Pi Pico W server (e.g. 192.168.1.100)')
            .addText(text => text
                .setPlaceholder('192.168.1.100')
                .setValue(this.plugin.settings.picoIp)
                .onChange(async (value) => {
                    this.plugin.settings.picoIp = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Credentials (Base64)')
            .setDesc('Base64 string of username:password (e.g., btoa("admin:password"))')
            .addText(text => text
                .setPlaceholder('YWRtaW46cGFzc3dvcmQ=')
                .setValue(this.plugin.settings.authStr)
                .onChange(async (value) => {
                    this.plugin.settings.authStr = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Remote Vault Folder')
            .setDesc(`Folder name on the SD card (leave empty to use current vault name: "${this.app.vault.getName()}")`)
            .addText(text => text
                .setPlaceholder(this.app.vault.getName())
                .setValue(this.plugin.settings.vaultFolder)
                .onChange(async (value) => {
                    this.plugin.settings.vaultFolder = value.trim();
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Quick Sync Size Limit (KB)')
            .setDesc('Maximum file size in kilobytes for Quick Sync (default: 128 KB)')
            .addText(text => text
                .setPlaceholder('128')
                .setValue(String(this.plugin.settings.quickSyncMaxKb ?? 128))
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    this.plugin.settings.quickSyncMaxKb = isNaN(parsed) || parsed <= 0 ? 128 : parsed;
                    await this.plugin.saveSettings();
                }));
    }
}
