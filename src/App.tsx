import { useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
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
const AUTHOR_URL = "https://github.com/jingluoguo/lively-mascot";
const DEFAULT_SETTINGS: MascotSettings = {
  character: "ghost",
  emotion: "02",
  size: 260,
  viewMode: "3d",
  outlineVisible: true,
  followCursor: true,
  bodyColor: "#bdeef2",
  outlineColor: "#23434d",
  accentColor: "#a9d9ff",
};

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
    subtitle: "角色、外观与表情设置会立即同步。",
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
  },
  en: {
    dashboardLabel: "Dashboard",
    subtitle: "Character, appearance, and expression changes sync instantly.",
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
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_SETTINGS;
  }
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
    await settingsWindow.show();
    await settingsWindow.maximize();
    await settingsWindow.setFocus();
    await emitTo("settings", "mascot-settings-state", settings);
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

function PetWindow() {
  const hostRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<MascotInstance | null>(null);
  const happyResetTimerRef = useRef<number | null>(null);
  const pointerPollBusyRef = useRef(false);
  const [settings, setSettings] = useState(loadSettings);
  const [activeEmotion, setActiveEmotion] = useState(settings.emotion);

  const triggerHappy = () => {
    if (happyResetTimerRef.current !== null) window.clearTimeout(happyResetTimerRef.current);
    setActiveEmotion("10");
    happyResetTimerRef.current = window.setTimeout(() => {
      setActiveEmotion("02");
      happyResetTimerRef.current = null;
    }, 2200);
  };

  useEffect(() => {
    let stopUpdate: (() => void) | undefined;
    let stopRequest: (() => void) | undefined;
    let stopOpenSettings: (() => void) | undefined;
    void listen<MascotSettings>("mascot-settings-update", ({ payload }) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      setSettings(payload);
      setActiveEmotion(payload.emotion);
    }).then((unlisten) => { stopUpdate = unlisten; });
    void listen("mascot-settings-request", () => {
      void emitTo("settings", "mascot-settings-state", settings);
    }).then((unlisten) => { stopRequest = unlisten; });
    void listen("open-settings", () => {
      void openSettingsWindow(settings);
    }).then((unlisten) => { stopOpenSettings = unlisten; });
    return () => { stopUpdate?.(); stopRequest?.(); stopOpenSettings?.(); };
  }, [settings]);

  useEffect(() => {
    if (!hostRef.current) return;
    const livelyMascot = getLivelyMascot();
    if (!livelyMascot) return;
    const mascot = livelyMascot.createMascot(hostRef.current, {
      type: settings.character,
      size: settings.size,
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
    mascot.setEmotion(activeEmotion);
    return () => { mascot.destroy(); mascotRef.current = null; };
    // Recreate only when structural appearance settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.character, settings.size, settings.viewMode, settings.outlineVisible, settings.followCursor, settings.bodyColor, settings.outlineColor, settings.accentColor]);

  useEffect(() => {
    const size = petWindowSize(settings);
    const appWindow = getCurrentWindow();
    void (async () => {
      try {
        await appWindow.setSize(new LogicalSize(size.width, size.height));
        await invoke("position_main_window");
      } catch {
        // Browser previews do not expose native window sizing or positioning APIs.
      }
    })();
  }, [settings.character, settings.size]);

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
  }, []);

  const startDragging = async (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    try { await getCurrentWindow().startDragging(); } catch { /* Browser preview. */ }
  };

  const openSettings = async (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    await openSettingsWindow(settings);
  };

  return <main className="pet-window" onPointerDown={startDragging} onContextMenu={openSettings}>
    <div ref={hostRef} className="pet-host" aria-label="可拖拽的桌面宠物" />
  </main>;
}

function SettingsWindow() {
  const previewRef = useRef<HTMLDivElement>(null);
  const previewMascotRef = useRef<MascotInstance | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const [previewEmotion, setPreviewEmotion] = useState(settings.emotion);
  const [dashboardPreferences, setDashboardPreferences] = useState(loadDashboardPreferences);
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
  }, [dashboardPreferences.locale, text.dashboardLabel]);

  useEffect(() => {
    if (!previewRef.current || !livelyMascot) return;
    const mascot = livelyMascot.createMascot(previewRef.current, {
      type: settings.character,
      size: 210,
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

  const update = <K extends keyof MascotSettings>(key: K, value: MascotSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    void emitTo("main", "mascot-settings-update", next);
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
      <div className="settings-intro"><span className="settings-kicker">{text.dashboardLabel}</span><p>{text.subtitle}</p></div>
      <div className="dashboard-preferences">
        <div className="preference-control"><span>{text.language}</span><div className="segmented"><button type="button" className={dashboardPreferences.locale === "zh-CN" ? "selected" : ""} onClick={() => updateDashboardPreference("locale", "zh-CN")}>中文</button><button type="button" className={dashboardPreferences.locale === "en" ? "selected" : ""} onClick={() => updateDashboardPreference("locale", "en")}>EN</button></div></div>
        <div className="preference-control"><span>{text.theme}</span><div className="segmented"><button type="button" className={dashboardPreferences.theme === "light" ? "selected" : ""} onClick={() => updateDashboardPreference("theme", "light")}>{text.light}</button><button type="button" className={dashboardPreferences.theme === "dark" ? "selected" : ""} onClick={() => updateDashboardPreference("theme", "dark")}>{text.dark}</button></div></div>
        <a className="author-link" href={AUTHOR_URL} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); openAuthorPage(); }}>{text.aboutAuthor}<span aria-hidden="true">↗</span></a>
      </div>
    </header>
    <div className="settings-layout">
      <aside className="preview-pane">
        <div className="preview-stage"><div ref={previewRef} className="preview-host" /><span className="preview-status">{dashboardPreferences.locale === "zh-CN" ? livelyMascot?.emotions[previewEmotion]?.desc ?? text.idle : livelyMascot?.emotions[previewEmotion]?.name ?? text.idle}</span></div>
        <div className="character-picker">
          <span className="control-label">{text.characterModel}</span>
          <div className="character-grid">{characters.map((character) => <button key={character.id} type="button" className={settings.character === character.id ? "selected" : ""} onClick={() => selectCharacter(character.id)}><span>{character.symbol}</span><small>{character.name[dashboardPreferences.locale]}</small></button>)}</div>
        </div>
      </aside>
      <section className="settings-controls">
        <div className="control-section"><div className="section-title"><div><span className="control-label">BEHAVIOR</span><h2>{text.behavior}</h2></div><button className="reset-button" type="button" onClick={() => { setSettings(DEFAULT_SETTINGS); localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS)); void emitTo("main", "mascot-settings-update", DEFAULT_SETTINGS); }}>{text.reset}</button></div>
          <div className="control-row"><label htmlFor="size">{text.size}</label><div className="range-wrap"><input id="size" type="range" min="140" max="280" step="10" value={settings.size} onChange={(event) => update("size", Number(event.target.value))} /><output>{settings.size}px</output></div></div>
          <div className="control-row"><span>{text.viewMode}</span><div className="segmented">{(["2d", "3d"] as ViewMode[]).map((mode) => <button key={mode} type="button" className={settings.viewMode === mode ? "selected" : ""} onClick={() => update("viewMode", mode)}>{mode.toUpperCase()}</button>)}</div></div>
          <label className="toggle-row"><span><strong>{text.followCursor}</strong><small>{text.followHint}</small></span><input type="checkbox" checked={settings.followCursor} onChange={(event) => update("followCursor", event.target.checked)} /><i /></label>
          <label className="toggle-row"><span><strong>{text.outline}</strong><small>{text.outlineHint}</small></span><input type="checkbox" checked={settings.outlineVisible} onChange={(event) => update("outlineVisible", event.target.checked)} /><i /></label>
          <div className="color-row"><label>{text.bodyColor}<input type="color" value={settings.bodyColor} onChange={(event) => update("bodyColor", event.target.value)} /></label><label>{text.outlineColor}<input type="color" value={settings.outlineColor} onChange={(event) => update("outlineColor", event.target.value)} /></label><label>{text.accentColor}<input type="color" value={settings.accentColor} onChange={(event) => update("accentColor", event.target.value)} /></label></div>
        </div>
        <div className="control-section emotion-section"><div className="section-title"><div><span className="control-label">EMOTIONS</span><h2>{text.emotions}</h2></div><div className="emotion-actions"><span className="emotion-count">{Object.keys(livelyMascot?.emotions ?? {}).length} {text.emotionCount}</span><button className="apply-emotion-button" type="button" onClick={() => update("emotion", previewEmotion)}>{text.setEmotion}</button></div></div>
          <div className="emotion-scroll">{groupedEmotions.map((group) => <div className="emotion-group" key={group.id}><h3>{dashboardPreferences.locale === "zh-CN" ? group.name : englishEmotionGroups[group.id] ?? group.id}</h3><div className="emotion-grid">{group.emotions.map((emotion) => <button key={emotion.id} type="button" className={previewEmotion === emotion.id ? "selected" : ""} onClick={() => setPreviewEmotion(emotion.id)}><span>{dashboardPreferences.locale === "zh-CN" ? emotion.desc : emotion.name}</span><small>{emotion.id}</small></button>)}</div></div>)}</div>
        </div>
      </section>
    </div>
  </main>;
}

function App() {
  return new URLSearchParams(window.location.search).get("view") === "settings" ? <SettingsWindow /> : <PetWindow />;
}

export default App;
