import { useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import type { createMascot as CreateMascot, EmotionDefinition, MascotInstance, ViewMode } from "lively-mascot";
import "lively-mascot/dist/lively-mascot.min.js";
import "lively-mascot/dist/lively-mascot.min.css";
import "./App.css";

type MascotSettings = {
  character: string;
  emotion: string;
  size: number;
  viewMode: ViewMode;
  outlineVisible: boolean;
  followCursor: boolean;
  bodyColor: string;
  outlineColor: string;
  accentColor: string;
  globalShortcut: string;
};

type LivelyMascotApi = {
  createMascot: typeof CreateMascot;
  emotions: Record<string, EmotionDefinition>;
  emotionGroups: Record<string, { name: string; order: number }>;
};

type DashboardTheme = "light" | "dark";
type DashboardLocale = "zh-CN" | "en";
type DashboardPreferences = {
  theme: DashboardTheme;
  locale: DashboardLocale;
};

const STORAGE_KEY = "nightlight-mascot-settings";
const UI_STORAGE_KEY = "desktop-mascot-dashboard-preferences";
const AUTHOR_URL = "https://github.com/jingluoguo";
const DEFAULT_SETTINGS: MascotSettings = {
  character: "ghost",
  emotion: "02",
  size: 120,
  viewMode: "3d",
  outlineVisible: true,
  followCursor: true,
  bodyColor: "#bdeef2",
  outlineColor: "#23434d",
  accentColor: "#a9d9ff",
  globalShortcut: "CommandOrControl+Shift+M",
};
const MAX_MASCOT_SIZE = 160;

const characters = [
  { id: "ghost", name: { "zh-CN": "幽灵", en: "Ghost" }, symbol: "G" },
  { id: "sprout", name: { "zh-CN": "豆芽", en: "Sprout" }, symbol: "S" },
  { id: "cat", name: { "zh-CN": "猫咪", en: "Cat" }, symbol: "C" },
  { id: "robot", name: { "zh-CN": "机器人", en: "Robot" }, symbol: "R" },
  { id: "jelly", name: { "zh-CN": "果冻", en: "Jelly" }, symbol: "J" },
];

const uiText = {
  "zh-CN": {
    dashboardLabel: "仪表盘",
    subtitle: "让每一刻，都有一个轻盈的陪伴。",
    characterModel: "角色模型",
    behavior: "行为与外观",
    reset: "恢复默认",
    size: "模型大小",
    viewMode: "显示模式",
    followCursor: "鼠标跟随",
    followHint: "失去焦点时仍会感知系统鼠标位置",
    outline: "模型轮廓",
    outlineHint: "显示角色外侧描边",
    bodyColor: "主体",
    outlineColor: "轮廓",
    accentColor: "强调",
    emotions: "表情状态",
    emotionCount: "种",
    setEmotion: "设置表情",
    idle: "待机",
    light: "白天",
    dark: "黑夜",
    language: "语言",
    theme: "主题",
    aboutAuthor: "关于作者",
    globalShortcut: "全局快捷键",
    globalShortcutHint: "按下后显示或隐藏桌面宠物",
    recordShortcut: "录制快捷键",
    recordingShortcut: "请按下快捷键…",
    shortcutConflict: "该快捷键已被占用，请尝试其他组合",
  },
  en: {
    dashboardLabel: "Dashboard",
    subtitle: "A little companion for every moment.",
    characterModel: "Character",
    behavior: "Behavior & Appearance",
    reset: "Reset",
    size: "Mascot size",
    viewMode: "View mode",
    followCursor: "Follow cursor",
    followHint: "Tracks the system cursor even when unfocused",
    outline: "Character outline",
    outlineHint: "Show the outline around the character",
    bodyColor: "Body",
    outlineColor: "Outline",
    accentColor: "Accent",
    emotions: "Expressions",
    emotionCount: "total",
    setEmotion: "Set expression",
    idle: "Idle",
    light: "Light",
    dark: "Dark",
    language: "Language",
    theme: "Theme",
    aboutAuthor: "About the author",
    globalShortcut: "Global shortcut",
    globalShortcutHint: "Show or hide the desktop mascot",
    recordShortcut: "Record shortcut",
    recordingShortcut: "Press a shortcut…",
    shortcutConflict: "This shortcut is already in use. Try another combination.",
  },
} as const;

const englishEmotionGroups: Record<string, string> = {
  lifecycle: "Lifecycle",
  reaction: "Reactions",
  work: "Work states",
};

const defaultThemes: Record<string, Pick<MascotSettings, "bodyColor" | "outlineColor" | "accentColor">> = {
  sprout: { bodyColor: "#48ff42", outlineColor: "#080808", accentColor: "#ff9fb6" },
  cat: { bodyColor: "#3d4852", outlineColor: "#131a20", accentColor: "#eeb3c1" },
  robot: { bodyColor: "#6f879b", outlineColor: "#162332", accentColor: "#74e5ff" },
  ghost: { bodyColor: "#bdeef2", outlineColor: "#23434d", accentColor: "#a9d9ff" },
  jelly: { bodyColor: "#f29cc2", outlineColor: "#5a243e", accentColor: "#ffe0a8" },
};

const getLivelyMascot = () => (window as Window & { LivelyMascot?: LivelyMascotApi }).LivelyMascot;
const loadSettings = (): MascotSettings => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<MascotSettings>;
    const savedSize = Number(saved.size);
    const size = savedSize === 260
      ? DEFAULT_SETTINGS.size
      : Number.isFinite(savedSize)
        ? Math.min(160, Math.max(80, savedSize))
        : DEFAULT_SETTINGS.size;
    return { ...DEFAULT_SETTINGS, ...saved, size };
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

function CharacterPreview({ character, settings, emotion = "02", size = 36, className = "" }: { character: string; settings: MascotSettings; emotion?: string; size?: number; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewTheme = character === settings.character ? settings : { ...settings, character, ...defaultThemes[character] };

  useEffect(() => {
    if (!hostRef.current) return;
    const livelyMascot = getLivelyMascot();
    if (!livelyMascot) return;
    const mascot = livelyMascot.createMascot(hostRef.current, {
      type: character,
      size,
      color: previewTheme.bodyColor,
      outline: previewTheme.outlineColor,
      accent: previewTheme.accentColor,
      viewMode: settings.viewMode,
      outlineVisible: settings.outlineVisible,
      followCursor: false,
      hopInterval: null,
      animated: false,
    });
    mascot.setEmotion(emotion);
    return () => mascot.destroy();
  }, [character, emotion, size, previewTheme.bodyColor, previewTheme.outlineColor, previewTheme.accentColor, settings.viewMode, settings.outlineVisible]);

  return <div ref={hostRef} className={`character-thumb-host ${className}`} aria-hidden="true" />;
}

function PetWindow() {
  const hostRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<MascotInstance | null>(null);
  const happyResetTimerRef = useRef<number | null>(null);
  const scaleFrameRef = useRef<number | null>(null);
  const scaleTargetRef = useRef(1);
  const scaleValueRef = useRef(1);
  const scaleVelocityRef = useRef(0);
  const pointerPollBusyRef = useRef(false);
  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  const [activeEmotion, setActiveEmotion] = useState(settings.emotion);
  settingsRef.current = settings;

  const triggerHappy = () => {
    if (happyResetTimerRef.current !== null) window.clearTimeout(happyResetTimerRef.current);
    setActiveEmotion("10");
    happyResetTimerRef.current = window.setTimeout(() => {
      setActiveEmotion("02");
      happyResetTimerRef.current = null;
    }, 2200);
  };

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const registerListeners = async () => {
      const registered = await Promise.all([
        listen<MascotSettings>("mascot-settings-update", ({ payload }) => {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
          settingsRef.current = payload;
          setSettings(payload);
          setActiveEmotion(payload.emotion);
        }),
        listen("mascot-settings-request", () => {
          void emitTo("settings", "mascot-settings-state", settingsRef.current);
        }),
        listen("open-settings", () => {
          void openSettingsWindow(settingsRef.current);
        }),
      ]);
      if (disposed) {
        registered.forEach((unlisten) => unlisten());
      } else {
        unlisteners.push(...registered);
      }
    };
    void registerListeners();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    void invoke("set_global_shortcut", { shortcut: settings.globalShortcut }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!hostRef.current) return;
    const livelyMascot = getLivelyMascot();
    if (!livelyMascot) return;
    if (scaleFrameRef.current !== null) window.cancelAnimationFrame(scaleFrameRef.current);
    scaleFrameRef.current = null;
    scaleTargetRef.current = settings.size / MAX_MASCOT_SIZE;
    scaleValueRef.current = scaleTargetRef.current;
    scaleVelocityRef.current = 0;
    const mascot = livelyMascot.createMascot(hostRef.current, {
      type: settings.character,
      size: MAX_MASCOT_SIZE,
      color: settings.bodyColor,
      outline: settings.outlineColor,
      accent: settings.accentColor,
      viewMode: settings.viewMode,
      outlineVisible: settings.outlineVisible,
      followCursor: settings.followCursor,
      hopInterval: null,
      onClick: triggerHappy,
    });
    mascotRef.current = mascot;
    mascot.el.style.setProperty("--pet-scale", String(settings.size / MAX_MASCOT_SIZE));
    mascot.setEmotion(activeEmotion);
    return () => { mascot.destroy(); mascotRef.current = null; };
    // Recreate only when structural appearance settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.character, settings.viewMode, settings.outlineVisible, settings.followCursor, settings.bodyColor, settings.outlineColor, settings.accentColor]);

  useEffect(() => {
    const target = settings.size / MAX_MASCOT_SIZE;
    scaleTargetRef.current = target;
    if (scaleFrameRef.current !== null) return;

    let previousTime = performance.now();
    const stiffness = 190;
    const damping = 27; // Approximately critical damping: no overshoot.
    const animateScale = (time: number) => {
      const mascot = mascotRef.current;
      if (!mascot) {
        scaleFrameRef.current = null;
        return;
      }
      const deltaTime = Math.min((time - previousTime) / 1000, 0.032);
      previousTime = time;
      const displacement = scaleTargetRef.current - scaleValueRef.current;
      scaleVelocityRef.current += (displacement * stiffness - scaleVelocityRef.current * damping) * deltaTime;
      scaleValueRef.current += scaleVelocityRef.current * deltaTime;
      mascot.el.style.setProperty("--pet-scale", String(scaleValueRef.current));

      if (Math.abs(scaleTargetRef.current - scaleValueRef.current) < 0.0005 && Math.abs(scaleVelocityRef.current) < 0.0005) {
        scaleValueRef.current = scaleTargetRef.current;
        scaleVelocityRef.current = 0;
        mascot.el.style.setProperty("--pet-scale", String(scaleValueRef.current));
        scaleFrameRef.current = null;
        return;
      }
      scaleFrameRef.current = window.requestAnimationFrame(animateScale);
    };
    scaleFrameRef.current = window.requestAnimationFrame(animateScale);
  }, [settings.size]);

  useEffect(() => {
    // Keep a stable transparent canvas while the model is being scaled. The
    // native window only changes when a character's footprint changes.
    const canvasSettings = { ...settings, size: MAX_MASCOT_SIZE };
    const size = petWindowSize(canvasSettings);
    void invoke("resize_main_window", { width: size.width, height: size.height }).catch(() => {
      // Browser previews do not expose native window sizing or positioning APIs.
    });
  }, [settings.character]);

  useEffect(() => { mascotRef.current?.setEmotion(activeEmotion); }, [activeEmotion]);

  useEffect(() => {
    if (!settings.followCursor) return;
    const appWindow = getCurrentWindow();
    const pointerPoll = window.setInterval(async () => {
      if (pointerPollBusyRef.current) return;
      pointerPollBusyRef.current = true;
      try {
        const [cursor, windowPosition, scaleFactor] = await Promise.all([cursorPosition(), appWindow.outerPosition(), appWindow.scaleFactor()]);
        window.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX: (cursor.x - windowPosition.x) / scaleFactor,
          clientY: (cursor.y - windowPosition.y) / scaleFactor,
          pointerId: 1,
          pointerType: "mouse",
        }));
      } catch {
        // Browser previews do not expose native cursor coordinates.
      } finally {
        pointerPollBusyRef.current = false;
      }
    }, 50);
    return () => window.clearInterval(pointerPoll);
  }, [settings.followCursor]);

  useEffect(() => () => {
    if (happyResetTimerRef.current !== null) window.clearTimeout(happyResetTimerRef.current);
    if (scaleFrameRef.current !== null) window.cancelAnimationFrame(scaleFrameRef.current);
  }, []);

  const startDragging = async (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    try {
      const appWindow = getCurrentWindow();
      await appWindow.setFocus();
      await appWindow.startDragging();
    } catch { /* Browser preview. */ }
  };

  const openContextMenu = async (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    const appWindow = getCurrentWindow();
    try {
      const [position, scaleFactor] = await Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()]);
      await openContextMenuWindow(position.x + event.clientX * scaleFactor, position.y + event.clientY * scaleFactor);
    } catch {
      await openContextMenuWindow(event.clientX, event.clientY);
    }
  };

  return <main className="pet-window" onPointerDown={startDragging} onContextMenu={openContextMenu}>
    <div ref={hostRef} className="pet-host" aria-label="可拖拽的桌面宠物" />
  </main>;
}

const openContextMenuWindow = async (x: number, y: number) => {
  const width = 184;
  const height = 114;
  let menuWindow = await WebviewWindow.getByLabel("context-menu");
  if (!menuWindow) {
    menuWindow = new WebviewWindow("context-menu", {
      url: "/?view=context-menu",
      title: "",
      width,
      height,
      x,
      y,
      resizable: false,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      shadow: false,
    });
    await new Promise<void>((resolve) => {
      menuWindow?.once("tauri://created", () => resolve());
      menuWindow?.once("tauri://error", () => resolve());
    });
  }
  await menuWindow.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))).catch(() => undefined);
  await menuWindow.show().catch(() => undefined);
  await menuWindow.setFocus().catch(() => undefined);
};

function ContextMenuWindow() {
  const close = async () => {
    await getCurrentWindow().close().catch(() => undefined);
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const handleBlur = () => close();
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("blur", handleBlur);
    window.addEventListener("keydown", handleKeyDown);
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) void close();
    }).then((dispose) => { unlisten = dispose; });
    return () => {
      unlisten?.();
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
  return <main className="context-menu-window"><div className="pet-menu" role="menu">
    <div className="menu-actions">
      <button type="button" role="menuitem" onClick={async () => { await emitTo("main", "open-settings"); await close(); }}><span>仪表盘</span><small>⌘</small></button>
      <button type="button" role="menuitem" onClick={async () => { await invoke("hide_main_window").catch(() => undefined); await close(); }}><span>隐藏</span><small>H</small></button>
      <button type="button" role="menuitem" className="menu-danger" onClick={() => { void invoke("quit_app").catch(() => undefined); }}><span>退出</span><small>Q</small></button>
    </div>
  </div></main>;
}

function SettingsWindow() {
  const previewRef = useRef<HTMLDivElement>(null);
  const previewMascotRef = useRef<MascotInstance | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [previewEmotion, setPreviewEmotion] = useState(settings.emotion);
  const [dashboardPreferences, setDashboardPreferences] = useState(loadDashboardPreferences);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const shortcutButtonRef = useRef<HTMLButtonElement>(null);
  const shortcutBeforeRecordingRef = useRef(settings.globalShortcut);
  const text = uiText[dashboardPreferences.locale];
  const livelyMascot = getLivelyMascot();
  const groupedEmotions = useMemo(() => {
    if (!livelyMascot) return [];
    const groups = livelyMascot.emotionGroups;
    return Object.entries(livelyMascot.emotions)
      .sort(([, a], [, b]) => (groups[a.group]?.order ?? 99) - (groups[b.group]?.order ?? 99) || a.id.localeCompare(b.id))
      .reduce<Array<{ id: string; name: string; emotions: EmotionDefinition[] }>>((result, [, emotion]) => {
        let group = result.find((item) => item.id === emotion.group);
        if (!group) { group = { id: emotion.group, name: groups[emotion.group]?.name ?? emotion.group, emotions: [] }; result.push(group); }
        group.emotions.push(emotion);
        return result;
      }, []);
  }, [livelyMascot]);

  useEffect(() => {
    let stopState: (() => void) | undefined;
    void listen<MascotSettings>("mascot-settings-state", ({ payload }) => {
      setSettings(payload);
      setPreviewEmotion(payload.emotion);
    }).then((unlisten) => { stopState = unlisten; });
    void emitTo("main", "mascot-settings-request");
    return () => stopState?.();
  }, []);

  useEffect(() => {
    document.documentElement.lang = dashboardPreferences.locale;
    document.title = text.dashboardLabel;
  }, [dashboardPreferences.locale]);

  useEffect(() => {
    if (!previewRef.current || !livelyMascot) return;
    const mascot = livelyMascot.createMascot(previewRef.current, {
      type: settings.character,
      size: 168,
      color: settings.bodyColor,
      outline: settings.outlineColor,
      accent: settings.accentColor,
      viewMode: settings.viewMode,
      outlineVisible: settings.outlineVisible,
      followCursor: false,
      hopInterval: null,
    });
    previewMascotRef.current = mascot;
    mascot.setEmotion(previewEmotion);
    return () => { mascot.destroy(); previewMascotRef.current = null; };
  }, [livelyMascot, settings.character, settings.viewMode, settings.outlineVisible, settings.bodyColor, settings.outlineColor, settings.accentColor]);

  useEffect(() => { previewMascotRef.current?.setEmotion(previewEmotion); }, [previewEmotion]);

  useEffect(() => {
    if (!isRecordingShortcut) return;
    let active = true;
    let isApplyingShortcut = false;
    const releaseShortcut = invoke("set_global_shortcut", { shortcut: "" }).catch(() => undefined);
    shortcutButtonRef.current?.focus();
    const cancelRecording = () => {
      setShortcutDraft(null);
      setShortcutError(null);
      setIsRecordingShortcut(false);
    };
    const handleKeyDown = async (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        cancelRecording();
        return;
      }
      const shortcut = shortcutFromKeyboardEvent(event);
      if (shortcut && !isApplyingShortcut) {
        isApplyingShortcut = true;
        setShortcutDraft(shortcut);
        await releaseShortcut;
        if (!active) return;
        try {
          await invoke("set_global_shortcut", { shortcut });
          shortcutBeforeRecordingRef.current = shortcut;
          setShortcutDraft(null);
          setShortcutError(null);
          update("globalShortcut", shortcut);
          setIsRecordingShortcut(false);
        } catch {
          setShortcutError(text.shortcutConflict);
          isApplyingShortcut = false;
        }
      }
    };
    const handleWindowBlur = () => cancelRecording();
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      active = false;
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("blur", handleWindowBlur);
      void releaseShortcut
        .then(() => invoke("set_global_shortcut", { shortcut: shortcutBeforeRecordingRef.current }))
        .catch(() => undefined);
    };
  }, [isRecordingShortcut]);

  const update = <K extends keyof MascotSettings>(key: K, value: MascotSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    void emitTo("main", "mascot-settings-update", next);
  };
  const startShortcutRecording = () => {
    shortcutBeforeRecordingRef.current = settings.globalShortcut;
    setShortcutDraft(null);
    setShortcutError(null);
    setIsRecordingShortcut(true);
  };
  const cancelShortcutRecording = () => {
    if (!isRecordingShortcut) return;
    setShortcutDraft(null);
    setShortcutError(null);
    setIsRecordingShortcut(false);
  };
  const selectCharacter = (character: string) => {
    const next = { ...settings, character, ...defaultThemes[character] };
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    void emitTo("main", "mascot-settings-update", next);
  };
  const updateDashboardPreference = <K extends keyof DashboardPreferences>(key: K, value: DashboardPreferences[K]) => {
    const next = { ...dashboardPreferences, [key]: value };
    setDashboardPreferences(next);
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(next));
  };

  const openAuthorPage = () => {
    void invoke("open_author_page").catch(() => {
      window.open(AUTHOR_URL, "_blank", "noopener,noreferrer");
    });
  };

  return <main className={`settings-shell theme-${dashboardPreferences.theme}`}>
    <header className="settings-header">
      <div className="settings-intro"><h1>{text.characterModel}</h1><p>{text.subtitle}</p></div>
      <div className="dashboard-preferences">
        <div className="preference-control"><span>{text.language}</span><div className="segmented"><button type="button" className={dashboardPreferences.locale === "zh-CN" ? "selected" : ""} onClick={() => updateDashboardPreference("locale", "zh-CN")}>中文</button><button type="button" className={dashboardPreferences.locale === "en" ? "selected" : ""} onClick={() => updateDashboardPreference("locale", "en")}>EN</button></div></div>
        <div className="preference-control"><span>{text.theme}</span><div className="segmented"><button type="button" className={dashboardPreferences.theme === "light" ? "selected" : ""} onClick={() => updateDashboardPreference("theme", "light")}>{text.light}</button><button type="button" className={dashboardPreferences.theme === "dark" ? "selected" : ""} onClick={() => updateDashboardPreference("theme", "dark")}>{text.dark}</button></div></div>
        <a className="author-link" href={AUTHOR_URL} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); openAuthorPage(); }}>{text.aboutAuthor}<span aria-hidden="true">↗</span></a>
      </div>
    </header>
    <div className="settings-layout">
      <aside className="preview-pane">
        <div className="preview-stage"><div ref={previewRef} className="preview-host" /></div>
        <div className="character-picker">
          <span className="control-label">{text.characterModel}</span>
          <div className="character-grid">{characters.map((character) => <button key={character.id} type="button" className={settings.character === character.id ? "selected" : ""} onClick={() => selectCharacter(character.id)}><CharacterPreview character={character.id} settings={settings} /><small>{character.name[dashboardPreferences.locale]}</small></button>)}</div>
        </div>
      </aside>
      <section className="settings-controls">
        <div className="control-section"><div className="section-title"><div><span className="control-label">BEHAVIOR</span><h2>{text.behavior}</h2></div><button className="reset-button" type="button" onClick={() => { setSettings(DEFAULT_SETTINGS); localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS)); void emitTo("main", "mascot-settings-update", DEFAULT_SETTINGS); void invoke("set_global_shortcut", { shortcut: DEFAULT_SETTINGS.globalShortcut }).catch(() => undefined); }}>{text.reset}</button></div>
          <div className="control-row"><label htmlFor="size">{text.size}</label><div className="range-wrap"><input id="size" type="range" min="80" max="160" step="10" value={settings.size} onChange={(event) => update("size", Number(event.target.value))} /><output>{settings.size}px</output></div></div>
          <div className="control-row"><span>{text.viewMode}</span><div className="segmented">{(["2d", "3d"] as ViewMode[]).map((mode) => <button key={mode} type="button" className={settings.viewMode === mode ? "selected" : ""} onClick={() => update("viewMode", mode)}>{mode.toUpperCase()}</button>)}</div></div>
          <label className="toggle-row"><span><strong>{text.followCursor}</strong><small>{text.followHint}</small></span><input type="checkbox" checked={settings.followCursor} onChange={(event) => update("followCursor", event.target.checked)} /><i /></label>
          <label className="toggle-row"><span><strong>{text.outline}</strong><small>{text.outlineHint}</small></span><input type="checkbox" checked={settings.outlineVisible} onChange={(event) => update("outlineVisible", event.target.checked)} /><i /></label>
          <div className="shortcut-row"><div><strong>{text.globalShortcut}</strong><small>{text.globalShortcutHint}</small></div><div className="shortcut-control"><button ref={shortcutButtonRef} type="button" className={`shortcut-capture${isRecordingShortcut ? " recording" : ""}${shortcutError ? " conflict" : ""}`} onClick={startShortcutRecording} onBlur={cancelShortcutRecording} aria-label={text.recordShortcut}>{shortcutDraft ? shortcutDisplay(shortcutDraft) : isRecordingShortcut ? text.recordingShortcut : shortcutDisplay(settings.globalShortcut)}</button>{shortcutError && <small className="shortcut-error" role="alert">{shortcutError}</small>}</div></div>
          <div className="color-row"><label>{text.bodyColor}<input type="color" value={settings.bodyColor} onChange={(event) => update("bodyColor", event.target.value)} /></label><label>{text.outlineColor}<input type="color" value={settings.outlineColor} onChange={(event) => update("outlineColor", event.target.value)} /></label><label>{text.accentColor}<input type="color" value={settings.accentColor} onChange={(event) => update("accentColor", event.target.value)} /></label></div>
        </div>
        <div className="control-section emotion-section"><div className="section-title"><div><span className="control-label">EMOTIONS</span><h2>{text.emotions}</h2></div><div className="emotion-actions"><span className="emotion-count">{Object.keys(livelyMascot?.emotions ?? {}).length} {text.emotionCount}</span><button className="apply-emotion-button" type="button" onClick={() => update("emotion", previewEmotion)}>{text.setEmotion}</button></div></div>
          <div className="emotion-scroll">{groupedEmotions.map((group) => <div className="emotion-group" key={group.id}><h3>{dashboardPreferences.locale === "zh-CN" ? group.name : englishEmotionGroups[group.id] ?? group.id}</h3><div className="emotion-grid">{group.emotions.map((emotion) => <button key={emotion.id} type="button" className={previewEmotion === emotion.id ? "selected" : ""} onClick={() => setPreviewEmotion(emotion.id)}><CharacterPreview character={settings.character} settings={settings} emotion={emotion.id} size={48} className="emotion-thumb" /><span>{dashboardPreferences.locale === "zh-CN" ? emotion.desc : emotion.name}</span><small>{emotion.id}</small></button>)}</div></div>)}</div>
        </div>
      </section>
    </div>
  </main>;
}

function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "settings") return <SettingsWindow />;
  if (view === "context-menu") return <ContextMenuWindow />;
  return <PetWindow />;
}

export default App;
