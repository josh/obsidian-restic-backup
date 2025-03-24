module.exports = (() => {
  const obsidian = require("obsidian");
  const { Plugin, PluginSettingTab, Setting, Notice } = obsidian;
  const child_process = require("node:child_process");
  const util = require("node:util");
  const execFile = util.promisify(child_process.execFile);

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    resticBinPath: "",
    resticRepository: "",
    resticPasswordFile: "",
    resticPasswordCommand: "",
    resticTags: "",
    backupInterval: 60 * 60, // 1 hour
  });

  // Local settings are stored in `localStorage` rather than serialized to data.json
  const LOCAL_SETTINGS = Object.freeze([
    "enabled",
    "resticBinPath",
    "resticRepository",
    "resticPasswordFile",
    "resticPasswordCommand",
  ]);

  class ResticBackupPlugin extends Plugin {
    /**
     * @type {{
     *   enabled: boolean,
     *   resticBinPath: string,
     *   resticRepository: string,
     *   resticPasswordFile: string,
     *   resticPasswordCommand: string,
     *   resticTags: string,
     *   backupInterval: number,
     * }}
     */
    settings = DEFAULT_SETTINGS;

    async onload() {
      await this.loadSettings();

      this.addSettingTab(new ResticBackupSettingTab(this.app, this));

      if (this.settings.enabled === false) {
        return;
      }

      if (this.settings.backupInterval) {
        this.registerInterval(
          window.setInterval(() => {
            this.resticBackup();
          }, this.settings.backupInterval * 1000),
        );
      }

      this.addCommand({
        id: "restic-backup",
        name: "Backup",
        callback: () => {
          this.resticBackup()
            .then((result) => {
              new Notice(
                `Restic backup [${Math.round(result.total_duration * 1000)}ms]: ` +
                  `Backed up ${result.files_new} new files, ` +
                  `${result.files_changed} modified files ` +
                  `(${result.total_files_processed} total files processed)`,
              );
            })
            .catch((error) => {
              console.error(error);
              new Notice(`Restic backup [error]: ${error}`);
            });
        },
      });
    }

    async unload() {}

    /**
     * Load settings from disk.
     * @returns {Promise<void>}
     */
    async loadSettings() {
      /** @type {Record<string, any>} */
      let localSettings = {};
      const localJSON = window.localStorage.getItem(
        `${this.manifest.id}:settings`,
      );
      if (localJSON) {
        try {
          localSettings = JSON.parse(localJSON);
        } catch (error) {
          console.assert(
            !error,
            `Failed to parse ${this.manifest.id}:settings`,
            error,
          );
        }
      }

      let saveSettings = false;

      if (!localSettings.resticBinPath) {
        localSettings.resticBinPath = await detectRestic();
        saveSettings = true;
      }

      if (saveSettings) {
        await this.saveSettings();
        saveSettings = false;
      }

      this.settings = Object.assign(
        {},
        DEFAULT_SETTINGS,
        localSettings,
        await this.loadData(),
      );
    }

    /**
     * Save settings to disk.
     * @returns {Promise<void>}
     */
    async saveSettings() {
      /** @type {Record<string, any>} */
      const localSettings = {};
      /** @type {Record<string, any>} */
      const dataSettings = {};

      for (const [key, value] of Object.entries(this.settings)) {
        if (LOCAL_SETTINGS.includes(key)) {
          localSettings[key] = value;
        } else {
          dataSettings[key] = value;
        }
      }

      window.localStorage.setItem(
        `${this.manifest.id}:settings`,
        JSON.stringify(localSettings),
      );
      await this.saveData(dataSettings);
    }

    /**
     * Run restic backup
     * @returns {Promise<ResticSummary>}
     * @throws {Error} If restic repository is not configured or backup fails
     */
    async resticBackup() {
      if (!this.settings.resticRepository) {
        throw new Error("Restic repository not configured");
      }

      /**
       * @type {Record<string, string>}
       */
      const env = {
        ...process.env,
        RESTIC_REPOSITORY: this.settings.resticRepository,
      };

      if (this.settings.resticPasswordFile !== "") {
        env["RESTIC_PASSWORD_FILE"] = this.settings.resticPasswordFile;
      }
      if (this.settings.resticPasswordCommand !== "") {
        env["RESTIC_PASSWORD_COMMAND"] = this.settings.resticPasswordCommand;
      }

      // Type assertion since we know the adapter is a FileSystemAdapter
      const adapter = /** @type {obsidian.FileSystemAdapter} */ (
        this.app.vault.adapter
      );

      const args = [
        "backup",
        adapter.getBasePath(),
        "--json",
        "--skip-if-unchanged",
      ];

      if (this.settings.resticTags !== "") {
        /**
         * @type {string[]}
         */
        const tags = this.settings.resticTags.split(",").map((t) => t.trim());
        if (tags.length > 0) {
          for (const tag of tags) {
            args.push("--tag", tag);
          }
        }
      }

      const { stdout } = await execFile(this.settings.resticBinPath, args, {
        env,
      });
      return parseResticSummary(stdout);
    }
  }

  class ResticBackupSettingTab extends PluginSettingTab {
    /**
     * @type {ResticBackupPlugin}
     */
    plugin;

    /**
     * @param {obsidian.App} app
     * @param {ResticBackupPlugin} plugin
     */
    constructor(app, plugin) {
      super(app, plugin);
      this.plugin = plugin;
    }

    display() {
      const { containerEl } = this;
      containerEl.empty();

      new Setting(containerEl)
        .setName("Enable Automatic Backups")
        .setDesc("Enable or disable automatic backups")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.enabled)
            .onChange(async (value) => {
              this.plugin.settings.enabled = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Restic Binary")
        .setDesc("Path to restic binary")
        .addText((text) =>
          text
            .setPlaceholder("/opt/homebrew/bin/restic")
            .setValue(this.plugin.settings.resticBinPath)
            .onChange(async (value) => {
              this.plugin.settings.resticBinPath = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Restic Repository")
        .setDesc("The repository to backup to")
        .addText((text) =>
          text
            .setPlaceholder("/tmp/restic-repo")
            .setValue(this.plugin.settings.resticRepository)
            .onChange(async (value) => {
              this.plugin.settings.resticRepository = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Password File")
        .setDesc("Path to password file")
        .addText((text) =>
          text
            .setPlaceholder("/path/to/password-file")
            .setValue(this.plugin.settings.resticPasswordFile)
            .onChange(async (value) => {
              this.plugin.settings.resticPasswordFile = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Password Command")
        .setDesc("Command to get password")
        .addText((text) =>
          text
            .setPlaceholder(
              "/usr/bin/security find-generic-password -l 'restic' -w",
            )
            .setValue(this.plugin.settings.resticPasswordCommand)
            .onChange(async (value) => {
              this.plugin.settings.resticPasswordCommand = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Tags")
        .setDesc("Comma-separated list of tags")
        .addText((text) =>
          text
            .setPlaceholder("obsidian,notes")
            .setValue(this.plugin.settings.resticTags)
            .onChange(async (value) => {
              this.plugin.settings.resticTags = value;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Backup Interval")
        .setDesc("How often to backup (in seconds, 0 to disable)")
        .addText((text) =>
          text
            .setPlaceholder("3600")
            .setValue(String(this.plugin.settings.backupInterval))
            .onChange(async (value) => {
              this.plugin.settings.backupInterval = parseInt(value, 10);
              await this.plugin.saveSettings();
            }),
        );
    }
  }

  /**
   * @typedef {object} ResticSummary
   * @property {"summary"} message_type
   * @property {number} files_new
   * @property {number} files_changed
   * @property {number} files_unmodified
   * @property {number} dirs_new
   * @property {number} dirs_changed
   * @property {number} dirs_unmodified
   * @property {number} data_blobs
   * @property {number} tree_blobs
   * @property {number} data_added
   * @property {number} data_added_packed
   * @property {number} total_files_processed
   * @property {number} total_bytes_processed
   * @property {number} total_duration
   * @property {string} snapshot_id
   */

  /**
   * Parse restic backup summary output
   * @param {string} stdout - The stdout from restic backup command
   * @returns {ResticSummary} The parsed restic summary object
   * @throws {Error} If no summary is found in the output
   */
  function parseResticSummary(stdout) {
    const lines = stdout.trim().split("\n");
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.message_type === "summary") {
          return msg;
        }
      } catch {
        continue;
      }
    }
    throw new Error("No summary found in restic output");
  }

  /**
   * Get the path to the restic binary.
   *
   * @returns {Promise<string | null>}
   */
  async function detectRestic() {
    const env = await getShellEnv();
    try {
      const { stdout } = await execFile("which", ["restic"], { env });
      const result = stdout.trim();
      return result === "" ? null : result;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  /**
   * Get user's login shell environment variables.
   *
   * @returns {Promise<Record<string, string>>}
   */
  async function getShellEnv() {
    const shell = process.env.SHELL;
    assert(shell, "SHELL environment variable is set");
    const { stdout } = await execFile(shell, ["-l", "-c", "env"], {
      env: process.env,
    });
    /** @type {Record<string, string>} */
    const env = {};
    for (const line of stdout.split("\n")) {
      const [key, value] = line.split("=", 2);
      if (key) env[key] = value;
    }
    return env;
  }

  /**
   * @param {any} value
   * @param {string} message
   * @returns {asserts value}
   */
  function assert(value, message) {
    console.assert(value, message);
    if (!value) throw new Error(message);
  }

  return ResticBackupPlugin;
})();
