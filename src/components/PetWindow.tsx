import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
