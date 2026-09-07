import { useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import type { EmotionDefinition, MascotInstance, ModelCapabilities, ViewMode } from "lively-mascot";
import { AUTHOR_DATA_CACHE_KEY, AUTHOR_DATA_URL, characters, DEFAULT_SETTINGS, defaultThemes, englishEmotionGroups, UI_STORAGE_KEY, uiText, workTypeClass, workTypeName } from "../config";
import type { AppUpdateStatus, AuthorData, AuthorTag, CustomModelSummary, DashboardPreferences, DashboardTab, MascotSettings, ModelAction, ShortcutSettingKey } from "../types";
import { loadCachedAuthorData, openExternalUrl, parseAuthorData } from "../lib/author";
import { checkForAppUpdate as resolveAppUpdate } from "../lib/appUpdates";
import { downloadModelPackage, loadCustomModels, modelFilesFromSelection, modelImportErrorText } from "../lib/customModels";
import { getLivelyMascot } from "../lib/mascotRuntime";
import { loadDashboardPreferences, loadSettings, persistSettings, setGlobalShortcuts, shortcutDisplay, shortcutFromKeyboardEvent } from "../lib/settings";
import { CharacterPreview } from "./CharacterPreview";

const LIVELY_MASCOT_SKILL_URL = "https://github.com/jingluoguo/lively-mascot/tree/master/skills/lively-mascot-image-model";
export function SettingsWindow() {
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
  const [autostartState, setAutostartState] = useState<"loading" | "enabled" | "disabled" | "error">("loading");
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus>({ state: "idle", version: null, progress: null, message: null });
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

  const refreshAutostart = async () => {
    setAutostartState("loading");
    try {
      const enabled = await invoke<boolean>("check_autostart");
      setAutostartState(enabled ? "enabled" : "disabled");
    } catch {
      setAutostartState("error");
    }
  };

  useEffect(() => {
    void refreshAutostart();
  }, []);

  const updateAutostart = async (enabled: boolean) => {
    setAutostartBusy(true);
    try {
      const actual = await invoke<boolean>("set_autostart", { enabled });
      setAutostartState(actual ? "enabled" : "disabled");
    } catch {
      setAutostartState("error");
    } finally {
      setAutostartBusy(false);
    }
  };

  const checkForUpdate = async () => {
    try {
      setUpdateStatus((status) => ({ ...status, state: "checking", message: null }));
      const status = await resolveAppUpdate();
      setUpdateStatus(status);
      if (status.state === "available") setUpdateStatus(await invoke<AppUpdateStatus>("start_update_download"));
    } catch (error) {
      setUpdateStatus((status) => ({ ...status, state: "error", message: error instanceof Error ? error.message : null }));
    }
  };

  const handleUpdateAction = async () => {
    try {
      if (updateStatus.state === "ready") {
        setUpdateStatus((status) => ({ ...status, state: "installing", message: null }));
        await invoke("install_downloaded_update");
        await relaunch();
        return;
      }
      if (updateStatus.state === "downloading") {
        setUpdateStatus(await invoke<AppUpdateStatus>("pause_update_download"));
        return;
      }
      setUpdateStatus(await invoke<AppUpdateStatus>("start_update_download"));
    } catch (error) {
      setUpdateStatus((status) => ({ ...status, state: "error", message: error instanceof Error ? error.message : null }));
    }
  };

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
    let stopStatus: (() => void) | undefined;
    void listen<AppUpdateStatus>("update-status", ({ payload }) => setUpdateStatus(payload)).then((unlisten) => { stopStatus = unlisten; });
    void invoke<AppUpdateStatus>("get_update_status").then(setUpdateStatus).catch(() => undefined);
    return () => stopStatus?.();
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
  const updateStatusLabel = updateStatus.state === "checking" ? text.checkingForUpdate
    : updateStatus.state === "available" ? `${text.updateAvailable}${updateStatus.version ? ` · v${updateStatus.version}` : ""}`
      : updateStatus.state === "downloading" ? `${text.updateDownloading}${updateStatus.version ? ` · v${updateStatus.version}` : ""}`
        : updateStatus.state === "paused" ? `${text.updatePaused}${updateStatus.version ? ` · v${updateStatus.version}` : ""}`
          : updateStatus.state === "ready" ? `${text.updateReady}${updateStatus.version ? ` · v${updateStatus.version}` : ""}`
            : updateStatus.state === "installing" ? text.installingUpdate
              : updateStatus.state === "up-to-date" ? text.upToDate
                : updateStatus.state === "error" ? text.updateFailed
                  : text.updateNotChecked;
  const updateActionLabel = updateStatus.state === "downloading" ? text.pauseUpdate
    : updateStatus.state === "ready" ? text.installUpdate
      : updateStatus.state === "paused" ? text.resumeUpdate
        : text.downloadUpdate;
  const canActOnUpdate = ["available", "downloading", "paused", "ready"].includes(updateStatus.state);

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
        <span className="dashboard-version">v0.1.0 · lively 0.3.1</span>
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
                <div className={`model-dropzone${modelDragActive ? " active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setModelDragActive(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setModelDragActive(false); }} onDrop={(event) => void handleModelDrop(event)}><strong>{text.dropModel}</strong><span>{text.modelFormatHint}<a className="model-skill-link" href={LIVELY_MASCOT_SKILL_URL} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); openExternalUrl(LIVELY_MASCOT_SKILL_URL); }}>lively-mascot Skill</a>{dashboardPreferences.locale === "zh-CN" ? "。" : "."}</span><label className="model-import-button"><input type="file" accept=".livelymodel,.js,.css,.json" multiple onChange={importModel} />{text.chooseModel}</label></div>
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
            <section className="settings-group autostart-group">
              <div className="group-heading"><span className="control-label">SYSTEM</span><h2>{text.autostart}</h2></div>
              <div className="autostart-row">
                <div><strong>{autostartState === "enabled" ? text.autostartEnabled : autostartState === "disabled" ? text.autostartDisabled : text.autostartUnavailable}</strong><small>{text.autostartHint}</small></div>
                <div className="autostart-actions">
                  <button type="button" className="shortcut-capture" disabled={autostartBusy || autostartState === "loading"} onClick={() => void updateAutostart(autostartState !== "enabled")}>{autostartState === "enabled" ? text.autostartDisable : text.autostartEnable}</button>
                  <button type="button" className="autostart-refresh" disabled={autostartBusy || autostartState === "loading"} onClick={() => void refreshAutostart()}>{text.autostartRefresh}</button>
                </div>
              </div>
            </section>
            <section className="settings-group update-group">
              <div className="group-heading"><span className="control-label">UPDATE</span><h2>{text.appUpdate}</h2></div>
              <div className="update-row">
                <div>
                  <strong>{updateStatusLabel}</strong>
                  {updateStatus.state === "downloading" && <div className="dashboard-update-progress" aria-label={`${text.updateDownloading} ${Math.round(updateStatus.progress ?? 0)}%`}><i style={{ width: `${updateStatus.progress ?? 0}%` }} /></div>}
                  <small>{updateStatus.message || (updateStatus.state === "ready" ? text.updateReadyHint : updateStatus.state === "paused" ? text.updatePausedHint : text.appUpdateHint)}</small>
                </div>
                <div className="dashboard-update-actions">
                  <button type="button" className="autostart-refresh" disabled={updateStatus.state === "checking" || updateStatus.state === "installing"} onClick={() => void checkForUpdate()}>{text.checkForUpdate}</button>
                  {canActOnUpdate && <button type="button" className="shortcut-capture" onClick={() => void handleUpdateAction()}>{updateActionLabel}</button>}
                </div>
              </div>
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
