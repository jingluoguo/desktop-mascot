import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, STORAGE_KEY, UI_STORAGE_KEY } from "../config";
import type { DashboardPreferences, InteractionSettings, InteractionTrigger, MascotSettings, Reminder } from "../types";
import { isRecord } from "./author";
const persistSettings = (settings: MascotSettings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    settings,
  }));
};
const loadSettings = (): MascotSettings => {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    const saved = isRecord(raw) && isRecord(raw.settings)
      ? raw.settings as Partial<MascotSettings>
      : isRecord(raw)
        ? raw as Partial<MascotSettings>
        : {};
    const savedSize = Number(saved.size);
    const savedEdgeDockThreshold = Number(saved.edgeDockThreshold);
    const size = savedSize === 260
      ? DEFAULT_SETTINGS.size
      : Number.isFinite(savedSize)
        ? Math.min(160, Math.max(80, savedSize))
        : DEFAULT_SETTINGS.size;
    const viewMode = saved.viewMode === "2d" || saved.viewMode === "3d"
      ? saved.viewMode
      : DEFAULT_SETTINGS.viewMode;
    const faceVariant = saved.faceVariant === "simple" || saved.faceVariant === "dot"
      ? saved.faceVariant
      : DEFAULT_SETTINGS.faceVariant;
    const accessories = isRecord(saved.accessories)
      ? Object.fromEntries(Object.entries(saved.accessories).filter(([, value]) => typeof value === "boolean"))
      : {};
    const interactions = Object.fromEntries(
      (Object.keys(DEFAULT_SETTINGS.interactions) as InteractionTrigger[]).map((trigger) => [
        trigger,
        typeof saved.interactions === "object" && saved.interactions !== null && typeof (saved.interactions as Record<string, unknown>)[trigger] === "string"
          ? (saved.interactions as Record<string, string>)[trigger]
          : DEFAULT_SETTINGS.interactions[trigger],
      ]),
    ) as InteractionSettings;
    const color = (value: unknown, fallback: string) =>
      typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      size,
      viewMode,
      faceVariant,
      accessories,
      interactions,
      outlineVisible: typeof saved.outlineVisible === "boolean" ? saved.outlineVisible : DEFAULT_SETTINGS.outlineVisible,
      followCursor: typeof saved.followCursor === "boolean" ? saved.followCursor : DEFAULT_SETTINGS.followCursor,
      edgeDock: typeof saved.edgeDock === "boolean" ? saved.edgeDock : DEFAULT_SETTINGS.edgeDock,
      edgeDockThreshold: Number.isFinite(savedEdgeDockThreshold)
        ? Math.min(40, Math.max(0, Math.round(savedEdgeDockThreshold)))
        : DEFAULT_SETTINGS.edgeDockThreshold,
      bodyColor: color(saved.bodyColor, DEFAULT_SETTINGS.bodyColor),
      outlineColor: color(saved.outlineColor, DEFAULT_SETTINGS.outlineColor),
      accentColor: color(saved.accentColor, DEFAULT_SETTINGS.accentColor),
      globalShortcut: typeof saved.globalShortcut === "string" ? saved.globalShortcut : DEFAULT_SETTINGS.globalShortcut,
      dashboardShortcut: typeof saved.dashboardShortcut === "string" ? saved.dashboardShortcut : DEFAULT_SETTINGS.dashboardShortcut,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
};

const shortcutDisplay = (shortcut: string) => shortcut
  .replace(/CommandOrControl/g, "⌘/Ctrl")
  .replace(/Control/g, "⌃")
  .replace(/Command/g, "⌘")
  .replace(/Alt/g, "⌥")
  .replace(/Shift/g, "⇧")
  .replace(/\+/g, " ");

const shortcutFromKeyboardEvent = (event: KeyboardEvent) => {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return null;
  const normalized = key === " " ? "Space" : key;
  return parts.length > 0 ? [...parts, normalized].join("+") : normalized;
};

const setGlobalShortcuts = (settings: Pick<MascotSettings, "globalShortcut" | "dashboardShortcut">) => invoke("set_global_shortcuts", {
  visibilityShortcut: settings.globalShortcut,
  dashboardShortcut: settings.dashboardShortcut,
});

const petWindowSize = (settings: MascotSettings) => {
  const margins: Record<string, { x: number; y: number }> = {
    ghost: { x: 40, y: 70 },
    jelly: { x: 40, y: 60 },
    cat: { x: 110, y: 100 },
    robot: { x: 100, y: 120 },
    sprout: { x: 120, y: 180 },
  };
  const margin = margins[settings.character] ?? margins.ghost;
  return {
    width: Math.max(170, settings.size + margin.x),
    height: Math.max(170, settings.size + margin.y),
  };
};
const loadDashboardPreferences = (): DashboardPreferences => {
  try {
    return {
      theme: "dark",
      locale: "zh-CN",
      ...JSON.parse(localStorage.getItem(UI_STORAGE_KEY) ?? "{}"),
    };
  } catch {
    return { theme: "dark", locale: "zh-CN" };
  }
};

const openSettingsWindow = async (settings: MascotSettings) => {
  let settingsWindow = await WebviewWindow.getByLabel("settings");
  if (settingsWindow) {
    // Window commands can fail independently when the app was backgrounded.
    // Keep restoring the window even if it is already visible or maximized.
    await settingsWindow.unminimize().catch(() => undefined);
    await settingsWindow.setTitle("仪表盘").catch(() => undefined);
    await settingsWindow.show().catch(() => undefined);
    await settingsWindow.maximize().catch(() => undefined);
    await settingsWindow.setFocus().catch(() => undefined);
    await emitTo("settings", "mascot-settings-state", settings).catch(() => undefined);
    return;
  }
  settingsWindow = new WebviewWindow("settings", {
    url: "/?view=settings",
    title: "仪表盘",
    width: 820,
    height: 640,
    minWidth: 720,
    minHeight: 560,
    resizable: true,
    decorations: true,
    transparent: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    maximized: true,
  });
  settingsWindow.once("tauri://created", () => {
    window.setTimeout(() => {
      void settingsWindow?.maximize();
      void emitTo("settings", "mascot-settings-state", settings);
    }, 250);
  });
};
const listReminders = () => invoke<Reminder[]>("list_reminders");
const saveReminder = (reminder: Reminder) => invoke<Reminder[]>("save_reminder", { reminder });
const deleteReminder = (id: string) => invoke<Reminder[]>("delete_reminder", { id });
export { persistSettings, loadSettings, shortcutDisplay, shortcutFromKeyboardEvent, setGlobalShortcuts, petWindowSize, loadDashboardPreferences, openSettingsWindow, listReminders, saveReminder, deleteReminder };
