import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { openUrl } from "@tauri-apps/plugin-opener";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { createMascot as CreateMascot, EmotionDefinition, MascotInstance, ModelCapabilities, ViewMode } from "lively-mascot";
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
  dashboardShortcut: string;
  faceVariant: "default" | "simple" | "dot";
  accessories: Record<string, boolean>;
};

type ShortcutSettingKey = "globalShortcut" | "dashboardShortcut";

type LivelyMascotApi = {
  createMascot: typeof CreateMascot;
  emotions: Record<string, EmotionDefinition>;
  emotionGroups: Record<string, { name: string; order: number }>;
  models: Record<string, {
    name: string;
    parts?: Record<string, unknown>;
    gaze?: { scope?: "model" | "eyes" };
    rig?: { blink?: boolean; gaze?: boolean; hop?: boolean; spin?: boolean };
    accessories?: Record<string, { default: boolean; actions: string[] }>;
    presentation?: { labels?: { zh?: string; en?: string }; icon?: string; theme?: { body?: string; outline?: string; accent?: string } };
  }>;
};

type CustomModelSummary = { id: string; name: string; version: string; author: string };
type CustomModelSources = { id: string; model_js: string; model_css: string; model_json: string };
type ModelAction = "export" | "delete";

type DashboardTheme = "light" | "dark";
type DashboardLocale = "zh-CN" | "en";
type DashboardTab = "appearance" | "behavior" | "emotions" | "about";
type DashboardPreferences = {
  theme: DashboardTheme;
  locale: DashboardLocale;
};

type AuthorLink = {
  label: string;
  url: string;
};

type AuthorTag = {
  id: string;
  name: string;
  color: string;
};

type AuthorWork = {
  id: string;
  type: string;
  version: string;
  title: string;
  description: string;
  link: string;
  cover: string;
  tags: string[];
  status: boolean;
  featured: boolean;
  releasedAt: string;
};

type AuthorData = {
  schemaVersion: string;
  updatedAt: string;
  author: {
    id: string;
    name: string;
    bio: string;
    avatar: string;
    links: AuthorLink[];
  };
  tags: AuthorTag[];
  works: AuthorWork[];
};

const STORAGE_KEY = "nightlight-mascot-settings";
const SETTINGS_SCHEMA_VERSION = 2;
const UI_STORAGE_KEY = "desktop-mascot-dashboard-preferences";
const AUTHOR_DATA_CACHE_KEY = "desktop-mascot-author-data";
const AUTHOR_DATA_URL = "https://cdn.jsdelivr.net/gh/jingluoguo/jingluo_web@master/author.json";
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
  dashboardShortcut: "CommandOrControl+Shift+D",
  faceVariant: "default",
  accessories: {},
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
    appearanceTab: "角色与外观",
    behaviorTab: "行为与快捷键",
    emotionsTab: "表情",
    aboutTab: "关于作者",
    appearanceEyebrow: "外观",
    behaviorEyebrow: "偏好",
    emotionsEyebrow: "状态",
    aboutEyebrow: "关于",
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
    emotionApplied: "已应用到桌面宠物",
    idle: "待机",
    light: "白天",
    dark: "黑夜",
    language: "语言",
    theme: "主题",
    aboutAuthor: "关于作者",
    authorWorks: "作品",
    featuredWork: "精选",
    workVersion: "版本",
    releasedAt: "发布于",
    authorLoading: "正在读取作者资料…",
    authorUnavailable: "暂时无法读取作者资料",
    authorCached: "当前显示上次成功加载的数据",
    retry: "重试",
    dataUpdatedAt: "资料更新",
    globalShortcut: "显示或隐藏",
    globalShortcutHint: "按下后显示或隐藏桌面宠物",
    dashboardShortcut: "打开仪表盘",
    dashboardShortcutHint: "按下后打开并聚焦仪表盘",
    recordShortcut: "录制快捷键",
    recordingShortcut: "请按下快捷键…",
    shortcutConflict: "该快捷键已被占用，请尝试其他组合",
    importModel: "导入模型",
    modelTrustHint: "模型脚本将在本地应用窗口中运行，请仅导入来自 lively-mascot Skill 的文件。",
    modelImported: "模型已导入",
    modelExported: "模型包已导出",
    modelImportError: "模型导入失败",
    modelFormatHint: "支持 .livelymodel（ZIP 格式），或同时选择 model.js、model.css、model.json。文件应来自 lively-mascot Skill。",
    dropModel: "拖放模型文件到这里",
    chooseModel: "选择模型文件",
    modelPackageContents: "模型包应包含 model.js、model.css 和 model.json。",
    deleteModel: "删除模型",
    exportModel: "导出模型",
    deleteModelConfirm: "确定删除这个用户模型吗？删除后可重新导入，但无法恢复当前副本。",
    exportModelConfirm: "确定导出这个用户模型吗？将下载一个 .livelymodel 文件。",
    confirmModelAction: "确认操作",
    confirm: "确认",
    cancel: "取消",
    modelDeleted: "模型已删除",
    userModel: "用户模型",
    officialModel: "内置模型",
    modelCapabilities: "模型能力",
    modelParts: "部件",
    modelGaze: "注视",
    modelMotion: "动作",
    modelAccessories: "配件",
    faceVariant: "脸型",
    faceDefault: "默认",
    faceSimple: "简洁",
    faceDot: "点状",
    noAccessories: "当前模型没有可切换配件",
    modelImportInvalid: "无法读取模型。请确认模型包包含完整文件，并由 lively-mascot Skill 生成。",
    modelImportUnsupported: "模型包版本不受支持。请使用 lively-mascot 0.3.0 生成模型。",
    modelImportTooLarge: "模型文件超过 2 MB 限制，请压缩资源后重试。",
    modelImportUnsafe: "模型包含不允许的网络、动态代码或应用接口调用。",
  },
  en: {
    dashboardLabel: "Dashboard",
    subtitle: "A little companion for every moment.",
    appearanceTab: "Character & Style",
    behaviorTab: "Behavior & Shortcuts",
    emotionsTab: "Expressions",
    aboutTab: "About the Author",
    appearanceEyebrow: "Appearance",
    behaviorEyebrow: "Preferences",
    emotionsEyebrow: "State",
    aboutEyebrow: "About",
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
    emotionApplied: "Applied to desktop mascot",
    idle: "Idle",
    light: "Light",
    dark: "Dark",
    language: "Language",
    theme: "Theme",
    aboutAuthor: "About the author",
    authorWorks: "Selected work",
    featuredWork: "Featured",
    workVersion: "Version",
    releasedAt: "Released",
    authorLoading: "Loading author profile…",
    authorUnavailable: "The author profile is currently unavailable",
    authorCached: "Showing the last successfully loaded data",
    retry: "Retry",
    dataUpdatedAt: "Data updated",
    globalShortcut: "Show or hide",
    globalShortcutHint: "Show or hide the desktop mascot",
    dashboardShortcut: "Open dashboard",
    dashboardShortcutHint: "Open and focus the dashboard",
    recordShortcut: "Record shortcut",
    recordingShortcut: "Press a shortcut…",
    shortcutConflict: "This shortcut is already in use. Try another combination.",
    importModel: "Import model",
    modelTrustHint: "Model scripts run in this app window. Import files only from the lively-mascot Skill.",
    modelImported: "Model imported",
    modelExported: "Model package exported",
    modelImportError: "Model import failed",
    modelFormatHint: "Supports .livelymodel (ZIP), or model.js, model.css, and model.json selected together. Files should come from the lively-mascot Skill.",
    dropModel: "Drop model files here",
    chooseModel: "Choose model files",
    modelPackageContents: "A model package must contain model.js, model.css, and model.json.",
    deleteModel: "Delete model",
    exportModel: "Export model",
    deleteModelConfirm: "Delete this user model? You can import it again, but this copy cannot be restored.",
    exportModelConfirm: "Export this user model? A .livelymodel package will be downloaded.",
    confirmModelAction: "Confirm action",
    confirm: "Confirm",
    cancel: "Cancel",
    modelDeleted: "Model deleted",
    userModel: "User model",
    officialModel: "Built-in model",
    modelCapabilities: "Model capabilities",
    modelParts: "Parts",
    modelGaze: "Gaze",
    modelMotion: "Motion",
    modelAccessories: "Accessories",
    faceVariant: "Face",
    faceDefault: "Default",
    faceSimple: "Simple",
    faceDot: "Dot",
    noAccessories: "This model has no switchable accessories",
    modelImportInvalid: "The model could not be read. Confirm that the package is complete and was generated by the lively-mascot Skill.",
    modelImportUnsupported: "This model package version is not supported. Generate the model with lively-mascot 0.3.0.",
    modelImportTooLarge: "A model file exceeds the 2 MB limit. Reduce its size and try again.",
    modelImportUnsafe: "The model contains a blocked network, dynamic-code, or app-interface call.",
  },
} as const;

type UiCopy = { [Key in keyof typeof uiText["zh-CN"]]: string };

const englishEmotionGroups: Record<string, string> = {
  lifecycle: "Lifecycle",
  reaction: "Reactions",
  work: "Work states",
};

const workTypeName = (type: string, locale: DashboardLocale) => {
  const normalized = type.trim().toLowerCase();
  if (locale === "zh-CN") return ({ app: "应用", plugin: "插件", web: "网站", library: "库" } as Record<string, string>)[normalized] ?? type;
  return ({ app: "App", plugin: "Plugin", web: "Web", library: "Library" } as Record<string, string>)[normalized] ?? type;
};
const workTypeClass = (type: string) => type.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");

const defaultThemes: Record<string, Pick<MascotSettings, "bodyColor" | "outlineColor" | "accentColor">> = {
  sprout: { bodyColor: "#48ff42", outlineColor: "#080808", accentColor: "#ff9fb6" },
  cat: { bodyColor: "#3d4852", outlineColor: "#131a20", accentColor: "#eeb3c1" },
  robot: { bodyColor: "#6f879b", outlineColor: "#162332", accentColor: "#74e5ff" },
  ghost: { bodyColor: "#bdeef2", outlineColor: "#23434d", accentColor: "#a9d9ff" },
  jelly: { bodyColor: "#f29cc2", outlineColor: "#5a243e", accentColor: "#ffe0a8" },
};

const getLivelyMascot = () => (window as Window & { LivelyMascot?: LivelyMascotApi }).LivelyMascot;

const persistSettings = (settings: MascotSettings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    settings,
  }));
};

const loadCustomModels = async (): Promise<CustomModelSummary[]> => {
  const summaries = await invoke<CustomModelSummary[]>("list_custom_models");
  const modelApi = getLivelyMascot();
  const activeIds = new Set(summaries.map((summary) => summary.id));
  document.querySelectorAll<HTMLElement>("[data-lively-custom-model]").forEach((element) => {
    const id = element.dataset.livelyCustomModel;
    if (id && !activeIds.has(id)) {
      element.remove();
      if (modelApi?.models) delete modelApi.models[id];
    }
  });
  const loadedSummaries: CustomModelSummary[] = [];
  for (const summary of summaries) {
    try {
      const sources = await invoke<CustomModelSources>("read_custom_model", { id: summary.id });
      const styleId = `lively-custom-model-css-${summary.id}`;
      const scriptId = `lively-custom-model-js-${summary.id}`;
      document.getElementById(styleId)?.remove();
      document.getElementById(scriptId)?.remove();
      const style = document.createElement("style");
      style.id = styleId;
      style.dataset.livelyCustomModel = summary.id;
      style.textContent = sources.model_css;
      document.head.appendChild(style);
      const script = document.createElement("script");
      script.id = scriptId;
      script.dataset.livelyCustomModel = summary.id;
      script.text = sources.model_js;
      document.head.appendChild(script);
      if (!getLivelyMascot()?.models?.[summary.id]) throw new Error("model script did not register its manifest id");
      loadedSummaries.push(summary);
    } catch {
      document.getElementById(`lively-custom-model-css-${summary.id}`)?.remove();
      document.getElementById(`lively-custom-model-js-${summary.id}`)?.remove();
      if (modelApi?.models) delete modelApi.models[summary.id];
    }
  }
  return loadedSummaries;
};

const MODEL_PACKAGE_EXTENSION = ".livelymodel";
const MODEL_FILE_NAMES = ["model.js", "model.css", "model.json"] as const;
type ModelFilePayload = { id: string; model_js: string; model_css: string; model_json: string };

const modelFilesFromSelection = async (files: File[]): Promise<ModelFilePayload> => {
  const entries = new Map<string, string>();
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(MODEL_PACKAGE_EXTENSION)) {
      const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
      Object.entries(archive).forEach(([name, content]) => {
        const baseName = name.split("/").pop()?.toLowerCase() ?? "";
        if (MODEL_FILE_NAMES.includes(baseName as typeof MODEL_FILE_NAMES[number])) entries.set(baseName, strFromU8(content));
      });
    } else {
      const baseName = file.name.split("/").pop()?.toLowerCase() ?? "";
      if (MODEL_FILE_NAMES.includes(baseName as typeof MODEL_FILE_NAMES[number])) entries.set(baseName, await file.text());
    }
  }
  const missing = MODEL_FILE_NAMES.filter((name) => !entries.has(name));
  if (missing.length > 0) throw new Error(`Missing model files: ${missing.join(", ")}`);
  const manifest = JSON.parse(entries.get("model.json") ?? "") as { id?: unknown; formatVersion?: unknown };
  if (manifest.formatVersion !== undefined && manifest.formatVersion !== 1) throw new Error("Unsupported model package version");
  if (typeof manifest.id !== "string" || !/^[a-z0-9_-]+$/i.test(manifest.id)) throw new Error("Invalid model id");
  return { id: manifest.id, model_js: entries.get("model.js") ?? "", model_css: entries.get("model.css") ?? "", model_json: entries.get("model.json") ?? "" };
};

const modelImportErrorText = (error: unknown, text: UiCopy) => {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("unsupported") || message.includes("version")) return text.modelImportUnsupported;
  if (message.includes("large") || message.includes("2 mb")) return text.modelImportTooLarge;
  if (message.includes("forbidden") || message.includes("remote") || message.includes("blocked")) return text.modelImportUnsafe;
  return text.modelImportInvalid;
};

const modelPackageBlob = (sources: CustomModelSources, manifestJson = sources.model_json) => new Blob([
  zipSync({
    "model.js": strToU8(sources.model_js),
    "model.css": strToU8(sources.model_css),
    "model.json": strToU8(manifestJson),
  }),
], { type: "application/vnd.lively-mascot.model+zip" });

const downloadModelPackage = async (id: string) => {
  const sources = await invoke<CustomModelSources>("read_custom_model", { id });
  const manifest = JSON.parse(sources.model_json) as Record<string, unknown>;
  manifest.formatVersion = 1;
  const url = URL.createObjectURL(modelPackageBlob(sources, JSON.stringify(manifest, null, 2)));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${id}${MODEL_PACKAGE_EXTENSION}`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown) => typeof value === "string" ? value.trim() : "";
const booleanValue = (value: unknown) => typeof value === "boolean" ? value : undefined;
const isExternalUrl = (value: string) => {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
const parseAuthorData = (value: unknown): AuthorData | null => {
  if (!isRecord(value) || !isRecord(value.author)) return null;
  const author = value.author;
  const id = stringValue(author.id);
  const name = stringValue(author.name);
  if (!id || !name) return null;

  const links = Array.isArray(author.links)
    ? author.links.flatMap<AuthorLink>((item) => {
      if (!isRecord(item)) return [];
      const label = stringValue(item.label);
      const url = stringValue(item.url);
      return label && isExternalUrl(url) ? [{ label, url }] : [];
    })
    : [];
  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap<AuthorTag>((item) => {
      if (!isRecord(item)) return [];
      const tag = { id: stringValue(item.id), name: stringValue(item.name), color: stringValue(item.color) };
      return tag.id && tag.name ? [tag] : [];
    })
    : [];
  const works = (Array.isArray(value.works)
    ? value.works.flatMap<AuthorWork>((item) => {
      if (!isRecord(item)) return [];
      const workId = stringValue(item.id);
      const title = stringValue(item.title);
      const status = booleanValue(item.status) ?? false;
      if (!workId || !title || !status) return [];
      const link = stringValue(item.link);
      const cover = stringValue(item.cover);
      const workTags = Array.isArray(item.tags) ? item.tags.map(stringValue).filter(Boolean) : [];
      return [{
        id: workId,
        type: stringValue(item.type),
        version: stringValue(item.version),
        title,
        description: stringValue(item.description),
        link: isExternalUrl(link) ? link : "",
        cover: isExternalUrl(cover) ? cover : "",
        tags: workTags,
        status,
        featured: booleanValue(item.featured) ?? false,
        releasedAt: stringValue(item.releasedAt),
      }];
    })
    : []).sort((first, second) => Number(second.featured) - Number(first.featured));

  const avatar = stringValue(author.avatar);
  return {
    schemaVersion: stringValue(value.schemaVersion),
    updatedAt: stringValue(value.updatedAt),
    author: {
      id,
      name,
      bio: stringValue(author.bio),
      avatar: isExternalUrl(avatar) ? avatar : "",
      links,
    },
    tags,
    works,
  };
};
const loadCachedAuthorData = () => {
  try {
    return parseAuthorData(JSON.parse(localStorage.getItem(AUTHOR_DATA_CACHE_KEY) ?? "null"));
  } catch {
    return null;
  }
};
const openExternalUrl = (url: string) => {
  if (!isExternalUrl(url)) return;
  void openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
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
    const color = (value: unknown, fallback: string) =>
      typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      size,
      viewMode,
      faceVariant,
      accessories,
      outlineVisible: typeof saved.outlineVisible === "boolean" ? saved.outlineVisible : DEFAULT_SETTINGS.outlineVisible,
      followCursor: typeof saved.followCursor === "boolean" ? saved.followCursor : DEFAULT_SETTINGS.followCursor,
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
    mascot.setFaceVariant(settings.faceVariant);
    const modelAccessories = livelyMascot.models[character]?.accessories ?? {};
    Object.entries(modelAccessories).forEach(([id, definition]) => {
      const enabled = settings.accessories[`${character}:${id}`] ?? definition.default;
      mascot.setAccessory(id, enabled);
    });
    mascot.setEmotion(emotion);
    return () => mascot.destroy();
  }, [character, emotion, size, previewTheme.bodyColor, previewTheme.outlineColor, previewTheme.accentColor, settings.viewMode, settings.outlineVisible, settings.faceVariant, settings.accessories]);

  return <div ref={hostRef} className={`character-thumb-host ${className}`} aria-hidden="true" />;
}

function PetWindow({ modelRegistryVersion, onModelRegistryReload }: { modelRegistryVersion: number; onModelRegistryReload: () => Promise<void> }) {
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
          persistSettings(payload);
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
        listen("custom-models-updated", () => { void onModelRegistryReload(); }),
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
  }, [onModelRegistryReload]);

  useEffect(() => {
    void setGlobalShortcuts(settings).catch(() => undefined);
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
    mascot.setFaceVariant(settings.faceVariant);
    Object.entries(livelyMascot.models[settings.character]?.accessories ?? {}).forEach(([id, definition]) => {
      mascot.setAccessory(id, settings.accessories[`${settings.character}:${id}`] ?? definition.default);
    });
    mascotRef.current = mascot;
    mascot.el.style.setProperty("--pet-scale", String(settings.size / MAX_MASCOT_SIZE));
    mascot.setEmotion(activeEmotion);
    return () => { mascot.destroy(); mascotRef.current = null; };
    // Recreate only when structural appearance settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelRegistryVersion, settings.character, settings.viewMode, settings.faceVariant, settings.accessories, settings.outlineVisible, settings.followCursor, settings.bodyColor, settings.outlineColor, settings.accentColor]);

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
  const [emotionApplied, setEmotionApplied] = useState(false);
  const [dashboardPreferences, setDashboardPreferences] = useState(loadDashboardPreferences);
  const [activeTab, setActiveTab] = useState<DashboardTab>("appearance");
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutSettingKey | null>(null);
  const [shortcutDraft, setShortcutDraft] = useState<string | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [authorData, setAuthorData] = useState<AuthorData | null>(loadCachedAuthorData);
  const [authorDataState, setAuthorDataState] = useState<"loading" | "ready" | "cached" | "error">(() => loadCachedAuthorData() ? "cached" : "loading");
  const [authorLoadAttempt, setAuthorLoadAttempt] = useState(0);
  const [customModels, setCustomModels] = useState<CustomModelSummary[]>([]);
  const [modelRegistryVersion, setModelRegistryVersion] = useState(0);
  const [modelImportState, setModelImportState] = useState<"idle" | "ready" | "error">("idle");
  const [modelImportMessage, setModelImportMessage] = useState("");
  const [modelDragActive, setModelDragActive] = useState(false);
  const [modelActionFeedback, setModelActionFeedback] = useState<string | null>(null);
  const [pendingModelAction, setPendingModelAction] = useState<{ id: string; action: ModelAction } | null>(null);
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<ModelCapabilities | null>(null);
  const visibilityShortcutButtonRef = useRef<HTMLButtonElement>(null);
  const dashboardShortcutButtonRef = useRef<HTMLButtonElement>(null);
  const shortcutsBeforeRecordingRef = useRef({
    globalShortcut: settings.globalShortcut,
    dashboardShortcut: settings.dashboardShortcut,
  });
  const tabButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const text = uiText[dashboardPreferences.locale];
  const livelyMascot = getLivelyMascot();
  const refreshCustomModels = async () => {
    try {
      const loaded = await loadCustomModels();
      setCustomModels(loaded);
      setModelRegistryVersion((version) => version + 1);
    } catch {
      setCustomModels([]);
    }
  };
  const dashboardTabs: Array<{ id: DashboardTab; label: string; eyebrow: string }> = [
    { id: "appearance", label: text.appearanceTab, eyebrow: text.appearanceEyebrow },
    { id: "behavior", label: text.behaviorTab, eyebrow: text.behaviorEyebrow },
    { id: "emotions", label: text.emotionsTab, eyebrow: text.emotionsEyebrow },
    { id: "about", label: text.aboutTab, eyebrow: text.aboutEyebrow },
  ];
  const activeTabDefinition = dashboardTabs.find((tab) => tab.id === activeTab) ?? dashboardTabs[0];
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
    void refreshCustomModels();
  }, []);

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
    if (!pendingModelAction) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingModelAction(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingModelAction]);

  useEffect(() => {
    const controller = new AbortController();
    const loadAuthorData = async () => {
      if (!authorData) setAuthorDataState("loading");
      try {
        const response = await fetch(AUTHOR_DATA_URL, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`Author data request failed with ${response.status}`);
        const parsed = parseAuthorData(await response.json());
        if (!parsed) throw new Error("Author data does not match the supported schema");
        localStorage.setItem(AUTHOR_DATA_CACHE_KEY, JSON.stringify(parsed));
        setAuthorData(parsed);
        setAuthorDataState("ready");
      } catch {
        if (controller.signal.aborted) return;
        setAuthorDataState(authorData ? "cached" : "error");
      }
    };
    void loadAuthorData();
    return () => controller.abort();
  }, [authorLoadAttempt]);

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
    setRuntimeCapabilities(mascot.getCapabilities());
    mascot.setEmotion(previewEmotion);
    return () => { mascot.destroy(); previewMascotRef.current = null; setRuntimeCapabilities(null); };
  }, [activeTab, livelyMascot, modelRegistryVersion, settings.character, settings.viewMode, settings.faceVariant, settings.accessories, settings.outlineVisible, settings.bodyColor, settings.outlineColor, settings.accentColor]);

  useEffect(() => {
    previewMascotRef.current?.setEmotion(previewEmotion);
    setEmotionApplied(previewEmotion === settings.emotion);
  }, [previewEmotion, settings.emotion]);

  useEffect(() => {
    if (!recordingShortcut) return;
    let active = true;
    let isApplyingShortcut = false;
    const shortcutKey = recordingShortcut;
    const releaseShortcut = setGlobalShortcuts({ globalShortcut: "", dashboardShortcut: "" }).catch(() => undefined);
    (shortcutKey === "globalShortcut" ? visibilityShortcutButtonRef : dashboardShortcutButtonRef).current?.focus();
    const cancelRecording = () => {
      setShortcutDraft(null);
      setShortcutError(null);
      setRecordingShortcut(null);
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
          const nextShortcuts = { ...shortcutsBeforeRecordingRef.current, [shortcutKey]: shortcut };
          await setGlobalShortcuts(nextShortcuts);
          shortcutsBeforeRecordingRef.current = nextShortcuts;
          setShortcutDraft(null);
          setShortcutError(null);
          update(shortcutKey, shortcut);
          setRecordingShortcut(null);
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
        .then(() => setGlobalShortcuts(shortcutsBeforeRecordingRef.current))
        .catch(() => undefined);
    };
  }, [recordingShortcut]);

  const update = <K extends keyof MascotSettings>(key: K, value: MascotSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    persistSettings(next);
    void emitTo("main", "mascot-settings-update", next);
  };
  const startShortcutRecording = (shortcutKey: ShortcutSettingKey) => {
    shortcutsBeforeRecordingRef.current = {
      globalShortcut: settings.globalShortcut,
      dashboardShortcut: settings.dashboardShortcut,
    };
    setShortcutDraft(null);
    setShortcutError(null);
    setRecordingShortcut(shortcutKey);
  };
  const cancelShortcutRecording = () => {
    if (!recordingShortcut) return;
    setShortcutDraft(null);
    setShortcutError(null);
    setRecordingShortcut(null);
  };
  const selectCharacter = (character: string) => {
    const modelTheme = livelyMascot?.models?.[character]?.presentation?.theme;
    const next = { ...settings, character, ...defaultThemes[character], ...(modelTheme ? {
      bodyColor: modelTheme.body ?? settings.bodyColor,
      outlineColor: modelTheme.outline ?? settings.outlineColor,
      accentColor: modelTheme.accent ?? settings.accentColor,
    } : {}) };
    setSettings(next);
    persistSettings(next);
    void emitTo("main", "mascot-settings-update", next);
  };
  const installModelFiles = async (files: File[]) => {
    try {
      const payload = await modelFilesFromSelection(files);
      await invoke("install_custom_model", { upload: payload });
      await refreshCustomModels();
      setModelImportState("ready");
      setModelImportMessage(text.modelImported);
      setModelActionFeedback(null);
      void emitTo("main", "custom-models-updated");
    } catch (error) {
      setModelImportState("error");
      setModelImportMessage(modelImportErrorText(error, text));
    }
  };
  const importModel = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await installModelFiles(files);
  };
  const handleModelDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setModelDragActive(false);
    await installModelFiles(Array.from(event.dataTransfer.files));
  };
  const removeModel = async (id: string) => {
    try {
      await invoke("delete_custom_model", { id });
      if (settings.character === id) selectCharacter("ghost");
      await refreshCustomModels();
      setModelImportState("ready");
      setModelImportMessage(text.modelDeleted);
      setModelActionFeedback(null);
      void emitTo("main", "custom-models-updated");
    } catch (error) {
      setModelImportState("error");
      setModelImportMessage(modelImportErrorText(error, text));
    }
  };
  const requestModelAction = (id: string, action: ModelAction) => {
    setModelActionFeedback(null);
    setPendingModelAction({ id, action });
  };
  const confirmModelAction = async () => {
    if (!pendingModelAction) return;
    const { id, action } = pendingModelAction;
    setPendingModelAction(null);
    if (action === "delete") await removeModel(id);
    else await exportModel(id);
  };
  const exportModel = async (id: string) => {
    try {
      await downloadModelPackage(id);
      setModelImportState("ready");
      setModelImportMessage(text.modelExported);
      setModelActionFeedback(id);
    } catch (error) {
      setModelImportState("error");
      setModelImportMessage(modelImportErrorText(error, text));
    }
  };
  const updateDashboardPreference = <K extends keyof DashboardPreferences>(key: K, value: DashboardPreferences[K]) => {
    const next = { ...dashboardPreferences, [key]: value };
    setDashboardPreferences(next);
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(next));
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    setPreviewEmotion(DEFAULT_SETTINGS.emotion);
    persistSettings(DEFAULT_SETTINGS);
    void emitTo("main", "mascot-settings-update", DEFAULT_SETTINGS);
    void setGlobalShortcuts(DEFAULT_SETTINGS).catch(() => undefined);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = (index + 1) % dashboardTabs.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = (index - 1 + dashboardTabs.length) % dashboardTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = dashboardTabs.length - 1;
    else return;
    event.preventDefault();
    setActiveTab(dashboardTabs[nextIndex].id);
    tabButtonRefs.current[nextIndex]?.focus();
  };
  const activeModel = livelyMascot?.models?.[settings.character];
  const capabilityModel = runtimeCapabilities && runtimeCapabilities.presentation?.labels ? runtimeCapabilities : activeModel;
  const activeAccessories = Object.entries(capabilityModel?.accessories ?? {});
  const modelMotion = capabilityModel?.rig
    ? Object.entries(capabilityModel.rig).filter(([, enabled]) => enabled).map(([name]) => name).join(", ")
    : "";

  return <main className={`settings-shell dashboard-shell theme-${dashboardPreferences.theme}`}>
    <aside className="dashboard-sidebar">
      <div className="dashboard-brand">
        <img src="/favicon.svg" alt="" />
        <div><strong>Desktop Mascot</strong><span>{text.dashboardLabel}</span></div>
      </div>
      <nav className="dashboard-tabs" role="tablist" aria-label={text.dashboardLabel} aria-orientation="vertical">
        {dashboardTabs.map((tab, index) => <button
          key={tab.id}
          ref={(element) => { tabButtonRefs.current[index] = element; }}
          id={`dashboard-tab-${tab.id}`}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls="dashboard-panel"
          tabIndex={activeTab === tab.id ? 0 : -1}
          className={activeTab === tab.id ? "selected" : ""}
          onClick={() => setActiveTab(tab.id)}
          onKeyDown={(event) => handleTabKeyDown(event, index)}
        ><span>{String(index + 1).padStart(2, "0")}</span><strong>{tab.label}</strong></button>)}
      </nav>
      <div className="dashboard-sidebar-footer">
        <div className="preference-control"><span>{text.language}</span><div className="segmented" role="group" aria-label={text.language}><button type="button" aria-pressed={dashboardPreferences.locale === "zh-CN"} className={dashboardPreferences.locale === "zh-CN" ? "selected" : ""} onClick={() => updateDashboardPreference("locale", "zh-CN")}>中文</button><button type="button" aria-pressed={dashboardPreferences.locale === "en"} className={dashboardPreferences.locale === "en" ? "selected" : ""} onClick={() => updateDashboardPreference("locale", "en")}>EN</button></div></div>
        <div className="preference-control"><span>{text.theme}</span><div className="segmented" role="group" aria-label={text.theme}><button type="button" aria-pressed={dashboardPreferences.theme === "light"} className={dashboardPreferences.theme === "light" ? "selected" : ""} onClick={() => updateDashboardPreference("theme", "light")}>{text.light}</button><button type="button" aria-pressed={dashboardPreferences.theme === "dark"} className={dashboardPreferences.theme === "dark" ? "selected" : ""} onClick={() => updateDashboardPreference("theme", "dark")}>{text.dark}</button></div></div>
        <span className="dashboard-version">v0.1.0 · lively 0.3.0</span>
      </div>
    </aside>
    <section className="dashboard-workspace">
      <header className="dashboard-workspace-header">
        <div><span>{activeTabDefinition.eyebrow}</span><h1>{activeTabDefinition.label}</h1></div>
        {activeTab !== "about" && <button className="reset-button" type="button" onClick={resetSettings}>{text.reset}</button>}
      </header>
      <div className={`dashboard-scroll dashboard-scroll-${activeTab}`}>
        <div key={activeTab} id="dashboard-panel" className={`dashboard-panel dashboard-panel-${activeTab}`} role="tabpanel" aria-labelledby={`dashboard-tab-${activeTab}`}>
          {activeTab === "appearance" && <div className="appearance-layout">
            <aside className="preview-pane">
              <div className="preview-stage"><div ref={previewRef} className="preview-host" /></div>
            </aside>
            <div className="settings-groups">
              <section className="settings-group character-picker">
                <div className="group-heading"><span className="control-label">MODEL</span><h2>{text.characterModel}</h2></div>
                <div className="character-grid">{characters.map((character) => <button key={character.id} type="button" className={settings.character === character.id ? "selected" : ""} onClick={() => selectCharacter(character.id)}><CharacterPreview character={character.id} settings={settings} /><small>{character.name[dashboardPreferences.locale]}</small><em>{text.officialModel}</em></button>)}{customModels.map((model) => { const labels = livelyMascot?.models?.[model.id]?.presentation?.labels; const name = dashboardPreferences.locale === "zh-CN" ? labels?.zh || model.name : labels?.en || model.name; return <div key={model.id} className={`custom-model-card${settings.character === model.id ? " selected" : ""}`}><button type="button" className="custom-model-select" onClick={() => selectCharacter(model.id)}><span className="custom-model-preview"><CharacterPreview character={model.id} settings={settings} /></span><small>{name}</small><em>{text.userModel}{model.version ? ` · ${model.version}` : ""}{model.author ? ` · ${model.author}` : ""}</em></button><div className="custom-model-actions"><button type="button" onClick={(event) => { event.stopPropagation(); requestModelAction(model.id, "export"); }} aria-label={`${text.exportModel} ${name}`} title={text.exportModel}>↓</button><button type="button" onClick={(event) => { event.stopPropagation(); requestModelAction(model.id, "delete"); }} aria-label={`${text.deleteModel} ${name}`} title={text.deleteModel}>×</button></div>{modelActionFeedback === model.id && <small className="model-action-feedback" role="status">{text.modelExported}</small>}</div>; })}</div>
                <div className={`model-dropzone${modelDragActive ? " active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setModelDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setModelDragActive(false); }} onDrop={(event) => void handleModelDrop(event)}><strong>{text.dropModel}</strong><span>{text.modelFormatHint}</span><label className="model-import-button"><input type="file" accept=".livelymodel,.js,.css,.json" multiple onChange={importModel} />{text.chooseModel}</label></div>
                <small className="model-import-hint">{text.modelPackageContents}</small>
                {modelImportState !== "idle" && <small className={`model-import-status ${modelImportState}`}>{modelImportMessage || (modelImportState === "ready" ? text.modelImported : text.modelImportError)}</small>}
              </section>
              <section className="settings-group">
                <div className="group-heading"><span className="control-label">STYLE</span><h2>{text.behavior}</h2></div>
                <div className="control-row"><label htmlFor="size">{text.size}</label><div className="range-wrap"><input id="size" type="range" min="80" max="160" step="10" value={settings.size} onChange={(event) => update("size", Number(event.target.value))} /><output>{settings.size}px</output></div></div>
                <div className="control-row"><span>{text.viewMode}</span><div className="segmented" role="group" aria-label={text.viewMode}>{(["2d", "3d"] as ViewMode[]).map((mode) => <button key={mode} type="button" aria-pressed={settings.viewMode === mode} className={settings.viewMode === mode ? "selected" : ""} onClick={() => update("viewMode", mode)}>{mode.toUpperCase()}</button>)}</div></div>
                <div className="control-row"><span>{text.faceVariant}</span><div className="segmented" role="group" aria-label={text.faceVariant}>{([["default", text.faceDefault], ["simple", text.faceSimple], ["dot", text.faceDot]] as const).map(([variant, label]) => <button key={variant} type="button" aria-pressed={settings.faceVariant === variant} className={settings.faceVariant === variant ? "selected" : ""} onClick={() => update("faceVariant", variant)}>{label}</button>)}</div></div>
                <label className="toggle-row"><span><strong>{text.outline}</strong><small>{text.outlineHint}</small></span><input type="checkbox" checked={settings.outlineVisible} onChange={(event) => update("outlineVisible", event.target.checked)} /><i /></label>
                <div className="color-row"><label>{text.bodyColor}<input type="color" value={settings.bodyColor} onChange={(event) => update("bodyColor", event.target.value)} /></label><label>{text.outlineColor}<input type="color" value={settings.outlineColor} onChange={(event) => update("outlineColor", event.target.value)} /></label><label>{text.accentColor}<input type="color" value={settings.accentColor} onChange={(event) => update("accentColor", event.target.value)} /></label></div>
                <div className="model-capabilities"><span className="capability-label">{text.modelCapabilities}</span><div><span>{text.modelParts}: {Object.keys(capabilityModel?.parts ?? {}).join(", ") || "-"}</span><span>{text.modelGaze}: {capabilityModel?.gaze?.scope ?? "-"}</span><span>{text.modelMotion}: {modelMotion || "-"}</span></div></div>
                <div className="model-accessories"><span className="capability-label">{text.modelAccessories}</span>{activeAccessories.length === 0 ? <small>{text.noAccessories}</small> : activeAccessories.map(([id, definition]) => { const key = `${settings.character}:${id}`; return <label className="toggle-row" key={id}><span><strong>{id}</strong><small>{definition.actions.join(", ") || text.modelAccessories}</small></span><input type="checkbox" checked={settings.accessories[key] ?? definition.default} onChange={(event) => update("accessories", { ...settings.accessories, [key]: event.target.checked })} /><i /></label>; })}</div>
              </section>
            </div>
          </div>}
          {activeTab === "behavior" && <div className="behavior-layout settings-groups">
            <section className="settings-group">
              <div className="group-heading"><span className="control-label">POINTER</span><h2>{text.behavior}</h2></div>
              <label className="toggle-row"><span><strong>{text.followCursor}</strong><small>{text.followHint}</small></span><input type="checkbox" checked={settings.followCursor} onChange={(event) => update("followCursor", event.target.checked)} /><i /></label>
            </section>
            <section className="settings-group">
              <div className="group-heading"><span className="control-label">SHORTCUTS</span><h2>{text.recordShortcut}</h2></div>
              <div className="shortcut-row"><div><strong>{text.globalShortcut}</strong><small>{text.globalShortcutHint}</small></div><div className="shortcut-control"><button ref={visibilityShortcutButtonRef} type="button" className={`shortcut-capture${recordingShortcut === "globalShortcut" ? " recording" : ""}${recordingShortcut === "globalShortcut" && shortcutError ? " conflict" : ""}`} onClick={() => startShortcutRecording("globalShortcut")} onBlur={cancelShortcutRecording} aria-label={text.recordShortcut}>{recordingShortcut === "globalShortcut" ? shortcutDraft ? shortcutDisplay(shortcutDraft) : text.recordingShortcut : shortcutDisplay(settings.globalShortcut)}</button>{recordingShortcut === "globalShortcut" && shortcutError && <small className="shortcut-error" role="alert">{shortcutError}</small>}</div></div>
              <div className="shortcut-row"><div><strong>{text.dashboardShortcut}</strong><small>{text.dashboardShortcutHint}</small></div><div className="shortcut-control"><button ref={dashboardShortcutButtonRef} type="button" className={`shortcut-capture${recordingShortcut === "dashboardShortcut" ? " recording" : ""}${recordingShortcut === "dashboardShortcut" && shortcutError ? " conflict" : ""}`} onClick={() => startShortcutRecording("dashboardShortcut")} onBlur={cancelShortcutRecording} aria-label={text.recordShortcut}>{recordingShortcut === "dashboardShortcut" ? shortcutDraft ? shortcutDisplay(shortcutDraft) : text.recordingShortcut : shortcutDisplay(settings.dashboardShortcut)}</button>{recordingShortcut === "dashboardShortcut" && shortcutError && <small className="shortcut-error" role="alert">{shortcutError}</small>}</div></div>
            </section>
          </div>}
          {activeTab === "emotions" && <div className="emotion-layout">
            <aside className="preview-pane emotion-preview"><div className="preview-stage"><div ref={previewRef} className="preview-host" /></div><button className="apply-emotion-button" type="button" onClick={() => { update("emotion", previewEmotion); setEmotionApplied(true); }}>{text.setEmotion}<span aria-hidden="true">↗</span></button>{emotionApplied && <small className="emotion-applied" role="status">{text.emotionApplied}</small>}</aside>
            <section className="emotion-section"><div className="emotion-summary"><span>{Object.keys(livelyMascot?.emotions ?? {}).length} {text.emotionCount}</span></div><div className="emotion-scroll">{groupedEmotions.map((group) => <div className="emotion-group" key={group.id}><h3>{dashboardPreferences.locale === "zh-CN" ? group.name : englishEmotionGroups[group.id] ?? group.id}</h3><div className="emotion-grid">{group.emotions.map((emotion) => <button key={emotion.id} type="button" className={previewEmotion === emotion.id ? "selected" : ""} onClick={() => setPreviewEmotion(emotion.id)}><CharacterPreview character={settings.character} settings={settings} emotion={emotion.id} size={48} className="emotion-thumb" /><span>{dashboardPreferences.locale === "zh-CN" ? emotion.desc : emotion.name}</span><small>{emotion.id}</small></button>)}</div></div>)}</div></section>
          </div>}
          {activeTab === "about" && <div className="about-layout">
            {authorData ? <>
              <section className="author-profile" aria-labelledby="author-name">
                <div className="author-mark"><img src={authorData.author.avatar || "/favicon.svg"} alt={authorData.author.name} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = "/favicon.svg"; }} /></div>
                <div className="about-copy">
                  <span className="control-label">DESIGNED & BUILT BY</span>
                  <h2 id="author-name">{authorData.author.name}</h2>
                  <span className="author-handle">@{authorData.author.id}</span>
                  {authorData.author.bio && <p>{authorData.author.bio}</p>}
                  <div className="author-links">{authorData.author.links.map((link) => <button key={`${link.label}-${link.url}`} type="button" onClick={() => openExternalUrl(link.url)}>{link.label}<span aria-hidden="true">↗</span></button>)}</div>
                  {authorData.updatedAt && <span className="author-updated">{text.dataUpdatedAt}<time>{authorData.updatedAt}</time></span>}
                </div>
              </section>
              {authorDataState === "cached" && <div className="author-data-notice" role="status">{text.authorCached}<button type="button" onClick={() => setAuthorLoadAttempt((attempt) => attempt + 1)}>{text.retry}</button></div>}
              {authorData.works.length > 0 && <section className="author-works" aria-labelledby="author-works-heading">
                <div className="works-heading"><span className="control-label">PORTFOLIO</span><h2 id="author-works-heading">{text.authorWorks}</h2><span>{String(authorData.works.length).padStart(2, "0")}</span></div>
                <div className="works-grid">{authorData.works.map((work) => {
                  const workTags = work.tags.map((tagId) => authorData.tags.find((tag) => tag.id === tagId)).filter((tag): tag is AuthorTag => Boolean(tag));
                  const content = <>
                    {work.featured && <span className="featured-mark" title={text.featuredWork} aria-label={text.featuredWork}>{text.featuredWork}</span>}
                    <div className="work-cover">{work.cover ? <img src={work.cover} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <span>{work.title.slice(0, 1)}</span>}</div>
                    <div className="work-copy">{work.type && <span className={`work-type work-type-${work.type.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`}>{workTypeName(work.type, dashboardPreferences.locale)}</span>}<div className="work-title"><div><h3>{work.title}</h3>{work.version && <span className="work-version" title={text.workVersion}>{work.version}</span>}</div></div>{work.description && <p>{work.description}</p>}<div className="work-footer"><div className="work-tags">{workTags.map((tag) => <span key={tag.id}><i style={{ backgroundColor: tag.color }} />{tag.name}</span>)}</div>{work.releasedAt && <time>{text.releasedAt} {work.releasedAt}</time>}</div></div>
                  </>;
                  const cardClassName = `work-card${work.type ? ` work-card-${workTypeClass(work.type)}` : ""}${work.featured ? " featured" : ""}`;
                  return work.link
                    ? <button key={work.id} type="button" className={cardClassName} onClick={() => openExternalUrl(work.link)}>{content}</button>
                    : <article key={work.id} className={cardClassName}>{content}</article>;
                })}</div>
              </section>}
            </> : <div className="author-empty" role="status">
              <img src="/favicon.svg" alt="" />
              <strong>{authorDataState === "loading" ? text.authorLoading : text.authorUnavailable}</strong>
              {authorDataState === "error" && <button type="button" onClick={() => setAuthorLoadAttempt((attempt) => attempt + 1)}>{text.retry}</button>}
            </div>}
          </div>}
        </div>
      </div>
      {pendingModelAction && (() => {
        const model = customModels.find((item) => item.id === pendingModelAction.id);
        const labels = model ? livelyMascot?.models?.[model.id]?.presentation?.labels : undefined;
        const modelName = model ? dashboardPreferences.locale === "zh-CN" ? labels?.zh || model.name : labels?.en || model.name : pendingModelAction.id;
        const message = pendingModelAction.action === "delete" ? text.deleteModelConfirm : text.exportModelConfirm;
        return <div className="model-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingModelAction(null); }}><section className="model-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="model-confirm-title"><span className="control-label">{pendingModelAction.action === "delete" ? text.deleteModel : text.exportModel}</span><h2 id="model-confirm-title">{text.confirmModelAction}</h2><p>{message}</p><strong>{modelName}</strong><div className="model-confirm-actions"><button type="button" className="model-confirm-cancel" onClick={() => setPendingModelAction(null)}>{text.cancel}</button><button type="button" className={pendingModelAction.action === "delete" ? "model-confirm-danger" : "model-confirm-primary"} onClick={() => void confirmModelAction()}>{text.confirm}</button></div></section></div>;
      })()}
    </section>
  </main>;
}

function PetRoot() {
  const [modelRegistryVersion, setModelRegistryVersion] = useState(0);
  const reloadCustomModels = useCallback(async () => {
    await loadCustomModels();
    setModelRegistryVersion((version) => version + 1);
  }, []);
  useEffect(() => {
    void reloadCustomModels().catch(() => undefined);
  }, [reloadCustomModels]);
  return <PetWindow modelRegistryVersion={modelRegistryVersion} onModelRegistryReload={reloadCustomModels} />;
}

function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "settings") return <SettingsWindow />;
  if (view === "context-menu") return <ContextMenuWindow />;
  return <PetRoot />;
}

export default App;
