import type { createMascot as CreateMascot, EmotionDefinition, ViewMode } from "lively-mascot";

type InteractionTrigger = "click" | "doubleClick" | "hover" | "drag";
type InteractionSettings = Record<InteractionTrigger, string>;
type InteractionCapabilities = Partial<Record<InteractionTrigger, string[]>>;

type MascotSettings = {
  character: string;
  emotion: string;
  size: number;
  viewMode: ViewMode;
  outlineVisible: boolean;
  followCursor: boolean;
  edgeDock: boolean;
  edgeDockThreshold: number;
  bodyColor: string;
  outlineColor: string;
  accentColor: string;
  globalShortcut: string;
  dashboardShortcut: string;
  faceVariant: "default" | "simple" | "dot";
  accessories: Record<string, boolean>;
  interactions: InteractionSettings;
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
    interactions?: InteractionCapabilities;
  }>;
};

type CustomModelSummary = { id: string; name: string; version: string; author: string };
type CustomModelSources = { id: string; model_js: string; model_css: string; model_json: string };
type ModelAction = "export" | "delete";

type DashboardTheme = "light" | "dark";
type DashboardLocale = "zh-CN" | "en";
type DashboardTab = "appearance" | "behavior" | "focus" | "reminders" | "emotions" | "about";
type ReminderSchedule = "once" | "daily" | "weekdays" | "interval";
type Reminder = {
  id: string;
  title: string;
  enabled: boolean;
  schedule: ReminderSchedule;
  runAt: string;
  intervalMinutes: number | null;
  emotion: string;
  systemNotification: boolean;
  nextRunAt: number | null;
  lastFiredAt: number | null;
};
type PomodoroPhase = "focus" | "shortBreak" | "longBreak";
type PomodoroStatus = "idle" | "running" | "paused";
type PomodoroState = {
  title: string;
  phase: PomodoroPhase;
  status: PomodoroStatus;
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number;
  sessionDurationSeconds: number;
  remainingSeconds: number;
  endsAt: number | null;
  completedFocusToday: number;
  completedFocusDate: string;
};
type DashboardPreferences = {
  theme: DashboardTheme;
  locale: DashboardLocale;
};

type AppUpdateStatus = {
  state: "idle" | "checking" | "available" | "downloading" | "paused" | "ready" | "up-to-date" | "installing" | "error";
  version: string | null;
  progress: number | null;
  message: string | null;
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
export type { MascotSettings, InteractionTrigger, InteractionSettings, InteractionCapabilities, ShortcutSettingKey, LivelyMascotApi, CustomModelSummary, CustomModelSources, ModelAction, DashboardTheme, DashboardLocale, DashboardTab, DashboardPreferences, AppUpdateStatus, AuthorLink, AuthorTag, AuthorWork, AuthorData, ReminderSchedule, Reminder, PomodoroPhase, PomodoroStatus, PomodoroState };
