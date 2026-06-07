import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";

import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const TB_DESKTOP_IDS = [
    "thunderbird.desktop",
    "org.mozilla.Thunderbird.desktop",
];

// How long to wait after the last TB window closes before starting headless
// (gives the profile lock time to release)
const HEADLESS_DELAY_MS = 2000;

export default class ThunderbirdTrayExtension extends Extension {
    private _indicator: PanelMenu.Button | null = null;
    private _icon: St.Icon | null = null;
    private _toggleItem: PopupMenu.PopupMenuItem | null = null;

    private _windows: Set<Meta.Window> = new Set();

    // Set during quit to suppress headless respawn
    private _quitting = false;
    private _quitTimerId: number | null = null;
    private _headlessTimerId: number | null = null;

    private _headlessProc: Gio.Subprocess | null = null;
    private _headlessWatchCancellable: Gio.Cancellable | null = null;
    // True when we detected a pre-existing headless TB we didn't spawn (e.g. after extension reload)
    private _externalHeadless = false;

    enable() {
        this._windows = new Set();
        this._quitting = false;

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._icon = new St.Icon({ style_class: "system-status-icon" });
        this._icon.gicon = this._getThunderbirdIcon();
        this._indicator.add_child(this._icon);

        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Scan windows already open when the extension loads
        for (const actor of global.get_window_actors()) {
            const w = actor.get_meta_window();
            if (w) this._trackWindow(w);
        }
        if (this._windows.size === 0) this._detectExternalHeadless();

        // Primary: app-state-changed fires after the app is fully set up on Wayland
        Shell.AppSystem.get_default().connectObject(
            "app-state-changed",
            (_appSys: Shell.AppSystem, app: Shell.App) => {
                if (!this._isThunderbirdApp(app)) return;
                for (const w of app.get_windows()) this._trackWindow(w);
            },
            this
        );

        // Secondary: window-created works for additional windows once the app is running
        global.display.connectObject(
            "window-created",
            (_display: Meta.Display, window: Meta.Window) =>
                this._onWindowCreated(window),
            this
        );

        this._updateIndicator();
    }

    disable() {
        Shell.AppSystem.get_default().disconnectObject(this);
        global.display.disconnectObject(this);

        if (this._headlessTimerId !== null) {
            GLib.source_remove(this._headlessTimerId);
            this._headlessTimerId = null;
        }
        if (this._quitTimerId !== null) {
            GLib.source_remove(this._quitTimerId);
            this._quitTimerId = null;
        }

        // Leave headless process running — it's the user's TB session
        this._headlessWatchCancellable?.cancel();
        this._headlessWatchCancellable = null;
        this._headlessProc = null;
        this._externalHeadless = false;

        for (const window of this._windows) window.disconnectObject(this);
        this._windows.clear();

        // Destroy children before the parent so Clutter doesn't double-destroy
        this._toggleItem?.destroy();
        this._toggleItem = null;
        this._icon?.destroy();
        this._icon = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    private _buildMenu(): void {
        if (!this._indicator) return;
        const menu = this._indicator.menu as PopupMenu.PopupMenu;

        this._toggleItem = new PopupMenu.PopupMenuItem("Open Thunderbird");
        this._toggleItem.connectObject(
            "activate",
            this._toggleWindow.bind(this),
            this
        );
        menu.addMenuItem(this._toggleItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const closeToTrayItem = new PopupMenu.PopupMenuItem("Close to Tray");
        closeToTrayItem.connectObject(
            "activate",
            this._closeToTrayNow.bind(this),
            this
        );
        menu.addMenuItem(closeToTrayItem);

        const quitItem = new PopupMenu.PopupMenuItem("Quit Thunderbird");
        quitItem.connectObject(
            "activate",
            this._quitThunderbird.bind(this),
            this
        );
        menu.addMenuItem(quitItem);

        menu.connectObject(
            "open-state-changed",
            (_menu: PopupMenu.PopupMenu, isOpen: boolean) => {
                if (isOpen) this._updateIndicator();
                return undefined;
            },
            this
        );
    }

    private _getThunderbirdIcon(): Gio.Icon {
        const appSystem = Shell.AppSystem.get_default();
        for (const id of TB_DESKTOP_IDS) {
            const app = appSystem.lookup_app(id);
            if (app) return app.get_icon();
        }
        return Gio.ThemedIcon.new("mail-unread");
    }

    private _isThunderbirdApp(app: Shell.App): boolean {
        return app.get_id().toLowerCase().includes("thunderbird");
    }

    private _isThunderbirdWindow(window: Meta.Window): boolean {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(window);
        if (app) return this._isThunderbirdApp(app);
        // Fallback for XWayland / early window-created timing
        return window.get_wm_class()?.toLowerCase().includes("thunderbird") ?? false;
    }

    private _trackWindow(window: Meta.Window): void {
        if (!this._isThunderbirdWindow(window) || this._windows.has(window))
            return;

        // A TB window appeared — clear all headless tracking
        this._externalHeadless = false;
        if (this._headlessProc !== null) {
            this._headlessWatchCancellable?.cancel();
            this._headlessWatchCancellable = null;
            this._headlessProc = null;
        }

        this._windows.add(window);
        window.connectObject(
            "unmanaging",
            () => this._onWindowUnmanaging(window),
            "notify::minimized",
            () => this._updateIndicator(),
            this
        );
        this._updateIndicator();
    }

    private _onWindowCreated(window: Meta.Window): void {
        // May be a no-op if app isn't associated yet — app-state-changed will catch it
        this._trackWindow(window);
    }

    private _onWindowUnmanaging(window: Meta.Window): void {
        window.disconnectObject(this);
        this._windows.delete(window);

        if (!this._quitting && this._windows.size === 0) {
            this._scheduleHeadless();
        }

        this._updateIndicator();
    }

    private _scheduleHeadless(): void {
        if (this._headlessTimerId !== null) return;

        this._headlessTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            HEADLESS_DELAY_MS,
            () => {
                this._headlessTimerId = null;
                if (!this._quitting) this._startHeadless();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    private _startHeadless(): void {
        if (this._headlessProc !== null) return;

        try {
            const proc = Gio.Subprocess.new(
                ["thunderbird", "--headless"],
                Gio.SubprocessFlags.STDOUT_SILENCE |
                    Gio.SubprocessFlags.STDERR_SILENCE
            );
            this._headlessProc = proc;
            this._headlessWatchCancellable = new Gio.Cancellable();

            proc.wait_async(this._headlessWatchCancellable, (_p, result) => {
                this._headlessWatchCancellable = null;
                try {
                    proc.wait_finish(result);
                } catch (_e) {
                    return; // Cancelled — intentional stop in progress
                }
                if (this._headlessProc === proc) {
                    this._headlessProc = null;
                    // Respawn if it crashed unexpectedly (e.g. on sleep/wake)
                    if (!this._quitting && this._windows.size === 0) {
                        this._scheduleHeadless();
                    }
                    this._updateIndicator();
                }
            });

            Main.notify("Thunderbird", "Running in background");
            this._updateIndicator();
        } catch (e) {
            console.error(`thunderbird-tray: failed to start headless: ${e}`);
        }
    }

    private _stopHeadlessAndLaunch(): void {
        if (this._headlessProc === null) {
            GLib.spawn_command_line_async("thunderbird");
            return;
        }

        this._headlessWatchCancellable?.cancel();
        this._headlessWatchCancellable = null;

        const proc = this._headlessProc;
        this._headlessProc = null;
        this._updateIndicator();

        proc.send_signal(15); // SIGTERM

        proc.wait_async(null, (_p, result) => {
            try {
                proc.wait_finish(result);
            } catch (_e) {
                // Already exited — launch anyway
            }
            GLib.spawn_command_line_async("thunderbird");
        });
    }

    private _toggleWindow(): void {
        const windows = [...this._windows];

        if (windows.length === 0) {
            this._stopHeadlessAndLaunch();
            return;
        }

        const allMinimized = windows.every((w) => w.minimized);
        const time = global.get_current_time();

        if (allMinimized) {
            for (const w of windows) w.activate(time);
        } else {
            for (const w of windows) w.minimize();
        }
    }

    private _closeToTrayNow(): void {
        if (this._windows.size === 0) return;
        // Close windows; _onWindowUnmanaging will schedule the headless respawn
        const time = global.get_current_time();
        for (const window of this._windows) window.delete(time);
    }

    private _quitThunderbird(): void {
        this._quitting = true;
        this._externalHeadless = false;

        if (this._headlessProc !== null) {
            this._headlessWatchCancellable?.cancel();
            this._headlessWatchCancellable = null;
            this._headlessProc.send_signal(15);
            this._headlessProc = null;
        }

        const time = global.get_current_time();
        for (const window of this._windows) window.delete(time);

        this._quitTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._quitting = false;
            this._quitTimerId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    private _detectExternalHeadless(): void {
        try {
            const proc = Gio.Subprocess.new(
                ["pgrep", "thunderbird"],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.wait_async(null, (_p, result) => {
                try {
                    proc.wait_finish(result);
                    if (
                        proc.get_successful() &&
                        this._windows.size === 0 &&
                        this._headlessProc === null
                    ) {
                        this._externalHeadless = true;
                        this._updateIndicator();
                    }
                } catch (_e) {}
            });
        } catch (_e) {}
    }

    private _updateIndicator(): void {
        if (!this._icon || !this._toggleItem) return;

        const windows = [...this._windows];
        const hasWindows = windows.length > 0;
        const isHeadless = this._headlessProc !== null || this._externalHeadless;
        const allMinimized = hasWindows && windows.every((w) => w.minimized);

        this._icon.opacity = hasWindows || isHeadless ? 255 : 128;

        if (!hasWindows && !isHeadless) {
            this._toggleItem.label.text = "Open Thunderbird";
        } else if (!hasWindows || allMinimized) {
            this._toggleItem.label.text = "Show Thunderbird";
        } else {
            this._toggleItem.label.text = "Hide Thunderbird";
        }
    }
}
