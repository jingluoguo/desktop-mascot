import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import type { MascotInstance } from "lively-mascot";
import { MAX_MASCOT_SIZE } from "../config";
import type { MascotSettings } from "../types";
import { loadSettings, openSettingsWindow, persistSettings, petWindowSize, setGlobalShortcuts } from "../lib/settings";
import { getLivelyMascot } from "../lib/mascotRuntime";
export function PetWindow({ modelRegistryVersion, onModelRegistryReload }: { modelRegistryVersion: number; onModelRegistryReload: () => Promise<void> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<MascotInstance | null>(null);
  const happyResetTimerRef = useRef<number | null>(null);
  const scaleFrameRef = useRef<number | null>(null);
  const scaleTargetRef = useRef(1);
  const scaleValueRef = useRef(1);
  const scaleVelocityRef = useRef(0);
  const pointerPollBusyRef = useRef(false);
  const dragFrameRef = useRef<number | null>(null);
  const dragCursorPollRef = useRef<number | null>(null);
  const dragCursorPollBusyRef = useRef(false);
  const dragStateRef = useRef<{
    pointerId: number;
    target: HTMLElement;
    startCursorX: number;
    startCursorY: number;
    latestCursorX: number;
    latestCursorY: number;
    windowPosition: PhysicalPosition | null;
    pending: boolean;
  } | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  const [activeEmotion, setActiveEmotion] = useState(settings.emotion);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "downloading" | "ready" | "error">("idle");
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateVersion, setUpdateVersion] = useState("");
  const [updateProgress, setUpdateProgress] = useState(0);
  settingsRef.current = settings;

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    let cancelled = false;
    const checkForUpdate = async () => {
      setUpdateState("checking");
      let update: Update | null;
      try {
        update = await check();
      } catch {
        if (!cancelled) setUpdateState("idle");
        return;
      }
      if (cancelled || !update) {
        if (!cancelled) setUpdateState("idle");
        return;
      }
      setAvailableUpdate(update);
      setUpdateVersion(update.version);
      setUpdateProgress(0);
      setUpdateState("downloading");
      try {
        let downloaded = 0;
        let total = 0;
        await update.download((event: DownloadEvent) => {
          if (cancelled) return;
          if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
            downloaded = 0;
            setUpdateProgress(0);
          } else if (event.event === "Progress" && total > 0) {
            downloaded += event.data.chunkLength;
            setUpdateProgress(Math.min(100, downloaded / total * 100));
          } else if (event.event === "Finished") {
            setUpdateProgress(100);
          }
        });
        if (!cancelled) setUpdateState("ready");
      } catch {
        if (!cancelled) setUpdateState("error");
      }
    };
    void checkForUpdate();
    return () => { cancelled = true; };
  }, []);

  const installUpdate = async () => {
    if (!availableUpdate) return;
    setUpdateState("downloading");
    try {
      await availableUpdate.install();
      await relaunch();
    } catch {
      setUpdateState("error");
    }
  };

  const triggerHappy = () => {
    if (happyResetTimerRef.current !== null) window.clearTimeout(happyResetTimerRef.current);
    setActiveEmotion("10");
    happyResetTimerRef.current = window.setTimeout(() => {
      setActiveEmotion("02");
      happyResetTimerRef.current = null;
    }, 2200);
  };

  const queueDraggedWindowPosition = () => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pending || dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const activeDrag = dragStateRef.current;
      if (!activeDrag || !activeDrag.windowPosition || activeDrag.pending) return;
      activeDrag.pending = true;
      const cursorX = activeDrag.latestCursorX;
      const cursorY = activeDrag.latestCursorY;
      const x = activeDrag.windowPosition.x + Math.round(cursorX - activeDrag.startCursorX);
      const y = activeDrag.windowPosition.y + Math.round(cursorY - activeDrag.startCursorY);
      void getCurrentWindow().setPosition(new PhysicalPosition(x, y)).catch(() => undefined).finally(() => {
        const currentDrag = dragStateRef.current;
        if (!currentDrag || currentDrag.pointerId !== activeDrag.pointerId) return;
        currentDrag.pending = false;
        if (currentDrag.latestCursorX !== cursorX || currentDrag.latestCursorY !== cursorY) queueDraggedWindowPosition();
      });
    });
  };

  const stopDragging = (event: PointerEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (dragCursorPollRef.current !== null) {
      window.clearInterval(dragCursorPollRef.current);
      dragCursorPollRef.current = null;
    }
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (dragState.target.hasPointerCapture(event.pointerId)) dragState.target.releasePointerCapture(event.pointerId);
  };

  const startDragging = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    dragStateRef.current = {
      pointerId: event.pointerId,
      target,
      startCursorX: event.screenX * window.devicePixelRatio,
      startCursorY: event.screenY * window.devicePixelRatio,
      latestCursorX: event.screenX * window.devicePixelRatio,
      latestCursorY: event.screenY * window.devicePixelRatio,
      windowPosition: null,
      pending: false,
    };
    const appWindow = getCurrentWindow();
    void Promise.all([appWindow.outerPosition(), cursorPosition()]).then(([windowPosition, startCursor]) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      dragState.windowPosition = windowPosition;
      dragState.startCursorX = startCursor.x;
      dragState.startCursorY = startCursor.y;
      dragState.latestCursorX = startCursor.x;
      dragState.latestCursorY = startCursor.y;
      if (dragCursorPollRef.current !== null) window.clearInterval(dragCursorPollRef.current);
      dragCursorPollRef.current = window.setInterval(() => {
        const activeDrag = dragStateRef.current;
        if (!activeDrag || activeDrag.pointerId !== event.pointerId || dragCursorPollBusyRef.current) return;
        dragCursorPollBusyRef.current = true;
        void cursorPosition().then((position) => {
          const currentDrag = dragStateRef.current;
          if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;
          currentDrag.latestCursorX = position.x;
          currentDrag.latestCursorY = position.y;
          queueDraggedWindowPosition();
        }).catch(() => undefined).finally(() => {
          dragCursorPollBusyRef.current = false;
        });
      }, 16);
      queueDraggedWindowPosition();
    }).catch(() => undefined);
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
    mascot.el.addEventListener("pointerdown", startDragging);
    mascot.el.addEventListener("pointerup", stopDragging);
    mascot.el.addEventListener("pointercancel", stopDragging);
    mascot.el.addEventListener("lostpointercapture", stopDragging);
    return () => {
      mascot.el.removeEventListener("pointerdown", startDragging);
      mascot.el.removeEventListener("pointerup", stopDragging);
      mascot.el.removeEventListener("pointercancel", stopDragging);
      mascot.el.removeEventListener("lostpointercapture", stopDragging);
      mascot.destroy();
      mascotRef.current = null;
    };
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
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
    if (dragCursorPollRef.current !== null) window.clearInterval(dragCursorPollRef.current);
  }, []);

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

  return <main className="pet-window" onContextMenu={openContextMenu}>
    <div ref={hostRef} className="pet-host" aria-label="可拖拽的桌面宠物" />
    {updateState !== "idle" && updateState !== "checking" && <div className="update-overlay" role="status">
      <div className="update-card">
        <span className="update-kicker">DESKTOP MASCOT</span>
        {updateState === "downloading" && <><strong>正在下载更新 {updateVersion ? `v${updateVersion}` : ""}</strong><div className="update-progress"><i style={{ width: `${updateProgress}%` }} /></div><small>{updateProgress > 0 ? `${Math.round(updateProgress)}%` : "正在连接更新服务器…"}</small></>}
        {updateState === "ready" && <><strong>更新已下载完成（v{updateVersion}）</strong><small>现在重启应用并安装更新吗？</small><div className="update-actions"><button type="button" onClick={() => void installUpdate()}>重启更新</button><button type="button" className="secondary" onClick={() => setUpdateState("idle")}>稍后</button></div></>}
        {updateState === "error" && <><strong>更新下载失败</strong><small>请稍后重试，或前往 GitHub Release 手动更新。</small><div className="update-actions"><button type="button" onClick={() => window.location.reload()}>重新检查</button><button type="button" className="secondary" onClick={() => setUpdateState("idle")}>关闭</button></div></>}
      </div>
    </div>}
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
