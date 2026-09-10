import { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import type { MascotInstance } from "lively-mascot";
import { CONTEXT_MENU_WIDTH, MAX_MASCOT_SIZE, uiText } from "../config";
import type { DashboardPreferences, InteractionTrigger, MascotSettings, PomodoroState, Reminder } from "../types";
import { getPomodoro, loadDashboardPreferences, loadSettings, openSettingsWindow, persistSettings, petWindowSize, setGlobalShortcuts } from "../lib/settings";
import { getLivelyMascot } from "../lib/mascotRuntime";
import { checkForAppUpdate } from "../lib/appUpdates";

const MODEL_HIT_SELECTOR = [
  ".pet-host .lively-mascot .lively-body:not(.lively-body--custom-model)",
  ".pet-host .lively-mascot svg",
].join(", ");
const INTERACTIVE_HIT_SELECTOR = `${MODEL_HIT_SELECTOR}, .pet-reminder-toast`;

const revealDockedPet = () => invoke<boolean>("reveal_main_window").catch(() => false);
const EDGE_DOCK_RETURN_DELAY = 6000;
const DRAG_EMOTION_REPEAT_DELAY = 1800;
const DRAG_MOVEMENT_THRESHOLD = 4;
const HOVER_SUPPRESS_AFTER_ACK = 300;
const CONTEXT_MENU_HEIGHT = 208;

export function PetWindow({ modelRegistryVersion, onModelRegistryReload }: { modelRegistryVersion: number; onModelRegistryReload: () => Promise<void> }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<MascotInstance | null>(null);
  const interactionResetTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const reminderActiveRef = useRef(false);
  const reminderSequenceRef = useRef(0);
  const pomodoroRef = useRef<PomodoroState | null>(null);
  const scaleFrameRef = useRef<number | null>(null);
  const scaleTargetRef = useRef(1);
  const scaleValueRef = useRef(1);
  const scaleVelocityRef = useRef(0);
  const pointerPollBusyRef = useRef(false);
  const followCursorPositionRef = useRef<PhysicalPosition | null>(null);
  const followCursorScaleFactorRef = useRef<number | null>(null);
  const lastFollowCursorRef = useRef<PhysicalPosition | null>(null);
  const ignoreCursorEventsRef = useRef(false);
  const dragFrameRef = useRef<number | null>(null);
  const dragCursorPollRef = useRef<number | null>(null);
  const dragCursorPollBusyRef = useRef(false);
  const dragPositionWriteRef = useRef<Promise<void> | null>(null);
  const edgeDockReturnTimerRef = useRef<number | null>(null);
  const ignoreHoverUntilRef = useRef(0);
  const pointerOverMascotRef = useRef(false);
  const dragEmotionTimerRef = useRef<number | null>(null);
  const dragEmotionFrameRef = useRef<number | null>(null);
  const activeDragEmotionRef = useRef<string | null>(null);
  const dragSequenceRef = useRef(0);
  const dragStateRef = useRef<{
    sequence: number;
    pointerId: number;
    target: HTMLElement;
    startCursorX: number;
    startCursorY: number;
    latestCursorX: number;
    latestCursorY: number;
    windowPosition: PhysicalPosition | null;
    pending: boolean;
    moved: boolean;
  } | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const settingsRef = useRef(settings);
  const [locale, setLocale] = useState(() => loadDashboardPreferences().locale);
  const localeRef = useRef(locale);
  const [activeEmotion, setActiveEmotion] = useState(settings.emotion);
  const [activeReminderTitle, setActiveReminderTitle] = useState<string | null>(null);
  settingsRef.current = settings;
  localeRef.current = locale;

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const checkForUpdate = async () => {
      try {
        const status = await checkForAppUpdate();
        if (status.state === "available") await invoke("start_update_download");
      } catch {
      }
    };
    void checkForUpdate();
  }, []);

  const scheduleEdgeDockReturn = () => {
    if (!settingsRef.current.edgeDock) return;
    if (edgeDockReturnTimerRef.current !== null) window.clearTimeout(edgeDockReturnTimerRef.current);
    edgeDockReturnTimerRef.current = window.setTimeout(() => {
      void invoke<boolean>("redock_main_window").catch(() => undefined);
      edgeDockReturnTimerRef.current = null;
    }, EDGE_DOCK_RETURN_DELAY);
  };

  // Acknowledging a reminder is an explicit dismissal, so a revealed pet goes back to the
  // edge right away. Waiting out the interaction delay here lets a hover reaction on the
  // model (the pointer is already sitting on it) push the retraction back over and over.
  const retractDockedPet = () => {
    if (edgeDockReturnTimerRef.current !== null) {
      window.clearTimeout(edgeDockReturnTimerRef.current);
      edgeDockReturnTimerRef.current = null;
    }
    void invoke<boolean>("redock_main_window").catch(() => undefined);
  };

  const pomodoroEmotion = () => {
    const pomodoro = pomodoroRef.current;
    if (!pomodoro || pomodoro.status === "idle") return null;
    if (pomodoro.status === "paused") return "05";
    return pomodoro.phase === "focus" ? "20" : pomodoro.phase === "shortBreak" ? "03" : "00";
  };
  const hasProtectedPresentation = () => pomodoroEmotion() !== null;
  const restorePresentation = () => {
    if (reminderActiveRef.current) return;
    setActiveEmotion(pomodoroEmotion() ?? settingsRef.current.emotion);
  };

  const interactionEmotion = (trigger: InteractionTrigger, overrideEmotion?: string) => {
    const livelyMascot = getLivelyMascot();
    const model = livelyMascot?.models[settingsRef.current.character];
    const emotion = overrideEmotion ?? settingsRef.current.interactions[trigger];
    const declaredEmotions = model?.interactions?.[trigger];
    return !emotion || emotion === "none" || !livelyMascot?.emotions[emotion] || (declaredEmotions && !declaredEmotions.includes(emotion))
      ? null
      : emotion;
  };

  const triggerInteraction = (trigger: InteractionTrigger, overrideEmotion?: string) => {
    if (reminderActiveRef.current || hasProtectedPresentation()) return;
    const emotion = interactionEmotion(trigger, overrideEmotion);
    if (!emotion) return;
    const showReaction = () => {
      if (interactionResetTimerRef.current !== null) window.clearTimeout(interactionResetTimerRef.current);
      setActiveEmotion(emotion);
      interactionResetTimerRef.current = window.setTimeout(() => {
        restorePresentation();
        interactionResetTimerRef.current = null;
      }, 2200);
    };
    showReaction();
    scheduleEdgeDockReturn();
  };

  const updateHoverState = (pointerOverMascot: boolean) => {
    if (!pointerOverMascot) {
      pointerOverMascotRef.current = false;
      return;
    }
    if (pointerOverMascotRef.current || dragStateRef.current || performance.now() < ignoreHoverUntilRef.current) return;
    pointerOverMascotRef.current = true;
    triggerInteraction("hover");
  };

  const scheduleClickInteraction = () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      triggerInteraction("click");
      clickTimerRef.current = null;
    }, 240);
  };

  const cancelInteraction = () => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (interactionResetTimerRef.current !== null) {
      window.clearTimeout(interactionResetTimerRef.current);
      interactionResetTimerRef.current = null;
      restorePresentation();
    }
  };

  const startDragEmotion = () => {
    if (reminderActiveRef.current || activeDragEmotionRef.current || hasProtectedPresentation()) return;
    const emotion = interactionEmotion("drag");
    if (!emotion) return;
    activeDragEmotionRef.current = emotion;
    if (interactionResetTimerRef.current !== null) {
      window.clearTimeout(interactionResetTimerRef.current);
      interactionResetTimerRef.current = null;
    }
    setActiveEmotion(emotion);
    const replay = () => {
      const mascot = mascotRef.current;
      if (!mascot || !dragStateRef.current || activeDragEmotionRef.current !== emotion) return;
      mascot.setEmotion(settingsRef.current.emotion);
      dragEmotionFrameRef.current = window.requestAnimationFrame(() => {
        dragEmotionFrameRef.current = null;
        if (dragStateRef.current && activeDragEmotionRef.current === emotion) mascot.setEmotion(emotion);
      });
    };
    replay();
    dragEmotionTimerRef.current = window.setInterval(replay, DRAG_EMOTION_REPEAT_DELAY);
  };

  const stopDragEmotion = () => {
    if (!activeDragEmotionRef.current) return;
    activeDragEmotionRef.current = null;
    if (dragEmotionTimerRef.current !== null) {
      window.clearInterval(dragEmotionTimerRef.current);
      dragEmotionTimerRef.current = null;
    }
    if (dragEmotionFrameRef.current !== null) {
      window.cancelAnimationFrame(dragEmotionFrameRef.current);
      dragEmotionFrameRef.current = null;
    }
    restorePresentation();
  };

  const finishDragging = (dragState: NonNullable<typeof dragStateRef.current>, pendingWrite: Promise<void> | null) => {
    if (!settingsRef.current.edgeDock) return;
    void (pendingWrite ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const cursor = await cursorPosition().catch(() => new PhysicalPosition(dragState.latestCursorX, dragState.latestCursorY));
        if (!dragState.windowPosition || dragStateRef.current) return null;
        const x = dragState.windowPosition.x + Math.round(cursor.x - dragState.startCursorX);
        const y = dragState.windowPosition.y + Math.round(cursor.y - dragState.startCursorY);
        // Pass this exact physical drop position to the native snap command.
        // Reading outerPosition there can return the previous frame on macOS.
        await getCurrentWindow().setPosition(new PhysicalPosition(x, y)).catch(() => undefined);
        return { x, y };
      })
      .then((position) => position && invoke<boolean>("dock_main_window_to_edge", {
        windowX: position.x,
        windowY: position.y,
        snapThreshold: settingsRef.current.edgeDockThreshold ?? 20,
      }))
      .catch(() => undefined);
  };

  const hasDragged = (dragState: NonNullable<typeof dragStateRef.current>, cursorX: number, cursorY: number) =>
    Math.hypot(cursorX - dragState.startCursorX, cursorY - dragState.startCursorY) >= DRAG_MOVEMENT_THRESHOLD;

  const stopDragging = (event: PointerEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const releaseCursorX = Math.round(event.screenX * window.devicePixelRatio);
    const releaseCursorY = Math.round(event.screenY * window.devicePixelRatio);
    dragState.latestCursorX = releaseCursorX;
    dragState.latestCursorY = releaseCursorY;
    dragState.moved ||= hasDragged(dragState, releaseCursorX, releaseCursorY);
    dragStateRef.current = null;
    stopDragEmotion();
    dragSequenceRef.current += 1;
    if (dragCursorPollRef.current !== null) {
      window.clearInterval(dragCursorPollRef.current);
      dragCursorPollRef.current = null;
    }
    if (dragFrameRef.current !== null) {
      window.cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    if (dragState.target.hasPointerCapture(event.pointerId)) dragState.target.releasePointerCapture(event.pointerId);
    const pendingWrite = dragPositionWriteRef.current;
    ignoreHoverUntilRef.current = performance.now() + 300;
    if (dragState.moved) {
      finishDragging(dragState, pendingWrite);
    } else if (event.type === "pointerup") {
      scheduleClickInteraction();
    }
  };

  const startDragging = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    if (edgeDockReturnTimerRef.current !== null) {
      window.clearTimeout(edgeDockReturnTimerRef.current);
      edgeDockReturnTimerRef.current = null;
    }
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    cancelInteraction();
    ignoreHoverUntilRef.current = Number.POSITIVE_INFINITY;
    pointerOverMascotRef.current = false;
    const dragSequence = dragSequenceRef.current + 1;
    dragSequenceRef.current = dragSequence;
    dragStateRef.current = {
      sequence: dragSequence,
      pointerId: event.pointerId,
      target,
      startCursorX: event.screenX * window.devicePixelRatio,
      startCursorY: event.screenY * window.devicePixelRatio,
      latestCursorX: event.screenX * window.devicePixelRatio,
      latestCursorY: event.screenY * window.devicePixelRatio,
      windowPosition: null,
      pending: false,
      moved: false,
    };
    const appWindow = getCurrentWindow();
    void Promise.all([appWindow.outerPosition(), cursorPosition()]).then(([windowPosition, startCursor]) => {
      const dragState = dragStateRef.current;
      if (!dragState || dragState.sequence !== dragSequence) return;
      dragState.windowPosition = windowPosition;
      dragState.startCursorX = startCursor.x;
      dragState.startCursorY = startCursor.y;
      dragState.latestCursorX = startCursor.x;
      dragState.latestCursorY = startCursor.y;
      if (dragCursorPollRef.current !== null) window.clearInterval(dragCursorPollRef.current);
      dragCursorPollRef.current = window.setInterval(() => {
        const activeDrag = dragStateRef.current;
        if (!activeDrag || activeDrag.sequence !== dragSequence || dragCursorPollBusyRef.current) return;
        dragCursorPollBusyRef.current = true;
        void cursorPosition().then((position) => {
          const currentDrag = dragStateRef.current;
          if (!currentDrag || currentDrag.sequence !== dragSequence) return;
          currentDrag.latestCursorX = position.x;
          currentDrag.latestCursorY = position.y;
          currentDrag.moved ||= hasDragged(currentDrag, position.x, position.y);
          if (currentDrag.moved) startDragEmotion();
          queueDraggedWindowPosition();
        }).catch(() => undefined).finally(() => {
          dragCursorPollBusyRef.current = false;
        });
      }, 16);
      queueDraggedWindowPosition();
    }).catch(() => undefined);
  };

  const handleDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    triggerInteraction("doubleClick");
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
      activeDrag.moved ||= hasDragged(activeDrag, cursorX, cursorY);
      const x = activeDrag.windowPosition.x + Math.round(cursorX - activeDrag.startCursorX);
      const y = activeDrag.windowPosition.y + Math.round(cursorY - activeDrag.startCursorY);
      if (activeDrag.moved) startDragEmotion();
      const positionWrite = getCurrentWindow().setPosition(new PhysicalPosition(x, y));
      dragPositionWriteRef.current = positionWrite;
      void positionWrite.catch(() => undefined).finally(() => {
        if (dragPositionWriteRef.current === positionWrite) dragPositionWriteRef.current = null;
        const currentDrag = dragStateRef.current;
        if (!currentDrag || currentDrag.sequence !== activeDrag.sequence) return;
        currentDrag.pending = false;
        if (currentDrag.latestCursorX !== cursorX || currentDrag.latestCursorY !== cursorY) queueDraggedWindowPosition();
      });
    });
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
          restorePresentation();
        }),
        listen("mascot-settings-request", () => {
          void emitTo("settings", "mascot-settings-state", settingsRef.current);
        }),
        listen<DashboardPreferences>("dashboard-preferences-update", ({ payload }) => {
          localeRef.current = payload.locale;
          setLocale(payload.locale);
        }),
        listen("open-settings", () => {
          void openSettingsWindow(settingsRef.current);
        }),
        listen("custom-models-updated", () => { void onModelRegistryReload(); }),
        listen<{ emotion: string }>("mascot-quick-emotion", ({ payload }) => {
          triggerInteraction("click", payload.emotion);
        }),
        listen("mascot-toggle-accessory", () => {
          const mascot = mascotRef.current;
          const [id, accessory] = Object.entries(mascot?.getAccessories() ?? {})[0] ?? [];
          if (!id || !accessory) return;
          const next = {
            ...settingsRef.current,
            accessories: { ...settingsRef.current.accessories, [`${settingsRef.current.character}:${id}`]: !accessory.enabled },
          };
          mascot?.setAccessory(id, !accessory.enabled);
          settingsRef.current = next;
          setSettings(next);
          persistSettings(next);
          void emitTo("settings", "mascot-settings-state", next);
        }),
        listen("mascot-context-menu-request", () => {
          const hasAccessories = Object.keys(mascotRef.current?.getAccessories() ?? {}).length > 0;
          const preferences = loadDashboardPreferences();
          void emitTo("context-menu", "mascot-context-menu-state", {
            hasAccessories,
            globalShortcut: settingsRef.current.globalShortcut,
            dashboardShortcut: settingsRef.current.dashboardShortcut,
            locale: preferences.locale,
            theme: preferences.theme,
          });
        }),
        listen<Reminder>("reminder-fired", ({ payload }) => {
          const reminderSequence = reminderSequenceRef.current + 1;
          reminderSequenceRef.current = reminderSequence;
          reminderActiveRef.current = true;
          if (clickTimerRef.current !== null) {
            window.clearTimeout(clickTimerRef.current);
            clickTimerRef.current = null;
          }
          if (interactionResetTimerRef.current !== null) {
            window.clearTimeout(interactionResetTimerRef.current);
            interactionResetTimerRef.current = null;
          }
          stopDragEmotion();
          void revealDockedPet().then(() => {
            if (reminderSequenceRef.current !== reminderSequence) return;
            void getCurrentWindow().setIgnoreCursorEvents(false).catch(() => undefined);
            ignoreCursorEventsRef.current = false;
            setActiveReminderTitle(payload.title);
            setActiveEmotion(payload.emotion || settingsRef.current.emotion);
          });
        }),
        listen<PomodoroState>("pomodoro-state", ({ payload }) => {
          pomodoroRef.current = payload;
          cancelInteraction();
          stopDragEmotion();
          restorePresentation();
        }),
        listen<PomodoroState>("pomodoro-completed", ({ payload }) => {
          pomodoroRef.current = payload;
          const reminderSequence = reminderSequenceRef.current + 1;
          reminderSequenceRef.current = reminderSequence;
          reminderActiveRef.current = true;
          cancelInteraction();
          stopDragEmotion();
          void revealDockedPet().then(() => {
            if (reminderSequenceRef.current !== reminderSequence) return;
            void getCurrentWindow().setIgnoreCursorEvents(false).catch(() => undefined);
            ignoreCursorEventsRef.current = false;
            const hasBreakStarted = payload.phase === "shortBreak" || payload.phase === "longBreak";
            const copy = uiText[localeRef.current];
            setActiveReminderTitle(hasBreakStarted ? copy.pomodoroBreakStarted : copy.pomodoroFocusStarted);
            setActiveEmotion(hasBreakStarted ? "30" : "01");
          });
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
  }, [onModelRegistryReload]);

  useEffect(() => {
    void getPomodoro().then((pomodoro) => {
      pomodoroRef.current = pomodoro;
      restorePresentation();
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    void setGlobalShortcuts(settings).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!settings.edgeDock) void revealDockedPet();
  }, [settings.edgeDock]);

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
    mascot.el.addEventListener("dblclick", handleDoubleClick);
    const handlePointerEnter = () => updateHoverState(true);
    const handlePointerLeave = () => updateHoverState(false);
    mascot.el.addEventListener("pointerenter", handlePointerEnter);
    mascot.el.addEventListener("pointerleave", handlePointerLeave);
    return () => {
      mascot.el.removeEventListener("pointerdown", startDragging);
      mascot.el.removeEventListener("pointerup", stopDragging);
      mascot.el.removeEventListener("pointercancel", stopDragging);
      mascot.el.removeEventListener("lostpointercapture", stopDragging);
      mascot.el.removeEventListener("dblclick", handleDoubleClick);
      mascot.el.removeEventListener("pointerenter", handlePointerEnter);
      mascot.el.removeEventListener("pointerleave", handlePointerLeave);
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
    let disposed = false;
    let unlistenMoved: (() => void) | undefined;
    let unlistenScaleChanged: (() => void) | undefined;

    const dispatchPointerMove = (cursor: PhysicalPosition) => {
      const windowPosition = followCursorPositionRef.current;
      const scaleFactor = followCursorScaleFactorRef.current;
      if (!windowPosition || !scaleFactor) return;
      window.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: (cursor.x - windowPosition.x) / scaleFactor,
        clientY: (cursor.y - windowPosition.y) / scaleFactor,
        pointerId: 1,
        pointerType: "mouse",
      }));
    };

    // Window coordinates rarely change. Cache them from native events instead
    // of requesting all three values on every cursor sample.
    void Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()]).then(([position, scaleFactor]) => {
      if (disposed) return;
      followCursorPositionRef.current = position;
      followCursorScaleFactorRef.current = scaleFactor;
    }).catch(() => {
      // Browser previews do not expose native window events or coordinates.
    });
    void (async () => {
      const removeMoved = await appWindow.onMoved(({ payload }) => {
        followCursorPositionRef.current = payload;
      });
      if (disposed) {
        removeMoved();
        return;
      }
      unlistenMoved = removeMoved;

      const removeScaleChanged = await appWindow.onScaleChanged(({ payload }) => {
        followCursorScaleFactorRef.current = payload.scaleFactor;
      });
      if (disposed) {
        removeScaleChanged();
        return;
      }
      unlistenScaleChanged = removeScaleChanged;
    })().catch(() => {
      // Browser previews do not expose native window events or coordinates.
    });

    const pointerPoll = window.setInterval(async () => {
      if (document.hidden || dragStateRef.current || pointerPollBusyRef.current) return;
      pointerPollBusyRef.current = true;
      try {
        const cursor = await cursorPosition();
        const previousCursor = lastFollowCursorRef.current;
        if (previousCursor && previousCursor.x === cursor.x && previousCursor.y === cursor.y) return;
        lastFollowCursorRef.current = cursor;
        dispatchPointerMove(cursor);
      } catch {
        // Browser previews do not expose native cursor coordinates.
      } finally {
        pointerPollBusyRef.current = false;
      }
    }, 100);
    return () => {
      disposed = true;
      window.clearInterval(pointerPoll);
      unlistenMoved?.();
      unlistenScaleChanged?.();
      followCursorPositionRef.current = null;
      followCursorScaleFactorRef.current = null;
      lastFollowCursorRef.current = null;
    };
  }, [settings.followCursor]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let hitTestBusy = false;
    let unlistenMoved: (() => void) | undefined;
    let unlistenScaleChanged: (() => void) | undefined;
    const setCursorEventsIgnored = (ignore: boolean) => {
      if (disposed || ignoreCursorEventsRef.current === ignore) return;
      ignoreCursorEventsRef.current = ignore;
      void appWindow.setIgnoreCursorEvents(ignore).catch(() => undefined);
    };
    setCursorEventsIgnored(true);
    const handlePointerMove = (event: PointerEvent) => {
      if (!event.isTrusted) return;
      if (dragStateRef.current) return;
      const target = event.target instanceof Element ? event.target : null;
      const pointerOverMascot = Boolean(target?.closest(MODEL_HIT_SELECTOR));
      const pointerOverInteractiveElement = Boolean(target?.closest(INTERACTIVE_HIT_SELECTOR));
      setCursorEventsIgnored(!pointerOverInteractiveElement);
      updateHoverState(pointerOverMascot);
    };
    const hitTestCursor = async () => {
      if (hitTestBusy || disposed) return;
      if (dragStateRef.current) {
        setCursorEventsIgnored(false);
        return;
      }
      hitTestBusy = true;
      try {
        const cursor = await cursorPosition();
        const windowPosition = followCursorPositionRef.current;
        const scaleFactor = followCursorScaleFactorRef.current;
        if (!windowPosition || !scaleFactor) return;
        const element = document.elementFromPoint(
          (cursor.x - windowPosition.x) / scaleFactor,
          (cursor.y - windowPosition.y) / scaleFactor,
        );
        const pointerOverMascot = Boolean(element?.closest(MODEL_HIT_SELECTOR));
        const pointerOverInteractiveElement = Boolean(element?.closest(INTERACTIVE_HIT_SELECTOR));
        setCursorEventsIgnored(!pointerOverInteractiveElement);
        updateHoverState(pointerOverMascot);
      } catch {
        // Browser previews do not expose native cursor coordinates.
      } finally {
        hitTestBusy = false;
      }
    };
    void Promise.all([appWindow.outerPosition(), appWindow.scaleFactor()]).then(([position, scaleFactor]) => {
      if (disposed) return;
      followCursorPositionRef.current = position;
      followCursorScaleFactorRef.current = scaleFactor;
    }).catch(() => undefined);
    void appWindow.onMoved(({ payload }) => {
      followCursorPositionRef.current = payload;
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenMoved = dispose;
    }).catch(() => undefined);
    void appWindow.onScaleChanged(({ payload }) => {
      followCursorScaleFactorRef.current = payload.scaleFactor;
    }).then((dispose) => {
      if (disposed) dispose();
      else unlistenScaleChanged = dispose;
    }).catch(() => undefined);
    window.addEventListener("pointermove", handlePointerMove, true);
    const hitTestPoll = window.setInterval(() => {
      // Pointer events cover the normal case. Poll only while the transparent
      // window cannot receive them, or while confirming that a hover ended.
      if (ignoreCursorEventsRef.current || pointerOverMascotRef.current) void hitTestCursor();
    }, 250);
    void hitTestCursor();
    return () => {
      disposed = true;
      window.clearInterval(hitTestPoll);
      window.removeEventListener("pointermove", handlePointerMove, true);
      unlistenMoved?.();
      unlistenScaleChanged?.();
      void appWindow.setIgnoreCursorEvents(false).catch(() => undefined);
      ignoreCursorEventsRef.current = false;
    };
  }, []);

  useEffect(() => () => {
    if (interactionResetTimerRef.current !== null) window.clearTimeout(interactionResetTimerRef.current);
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    if (edgeDockReturnTimerRef.current !== null) window.clearTimeout(edgeDockReturnTimerRef.current);
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

  const acknowledgeReminder = () => {
    reminderSequenceRef.current += 1;
    setActiveReminderTitle(null);
    reminderActiveRef.current = false;
    // The cursor is still resting on the pet when the toast gets dismissed, and the
    // drag/hover handlers would replay the hover reaction right away. Treat that hover
    // as already handled so the acknowledgement restores the presentation immediately.
    pointerOverMascotRef.current = true;
    ignoreHoverUntilRef.current = performance.now() + HOVER_SUPPRESS_AFTER_ACK;
    restorePresentation();
    retractDockedPet();
  };

  return <main className="pet-window" onContextMenu={openContextMenu}>
    <div ref={hostRef} className="pet-host" aria-label={uiText[locale].petAriaLabel} />
    {activeReminderTitle && <div className="pet-reminder-toast" role="alert"><span>{uiText[locale].petReminderLabel}</span><strong>{activeReminderTitle}</strong><button type="button" onClick={acknowledgeReminder}>{uiText[locale].acknowledgeReminder}</button></div>}
  </main>;
}

const openContextMenuWindow = async (x: number, y: number) => {
  let menuWindow = await WebviewWindow.getByLabel("context-menu");
  if (!menuWindow) {
    menuWindow = new WebviewWindow("context-menu", {
      url: "/?view=context-menu",
      title: "",
      width: CONTEXT_MENU_WIDTH,
      height: CONTEXT_MENU_HEIGHT,
      x: 0,
      y: 0,
      resizable: false,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      shadow: false,
      visible: false,
    });
    await new Promise<void>((resolve) => {
      menuWindow?.once("tauri://created", () => resolve());
      menuWindow?.once("tauri://error", () => resolve());
    });
  }
  const size = await menuWindow.outerSize().catch(() => ({ width: CONTEXT_MENU_WIDTH, height: CONTEXT_MENU_HEIGHT }));
  const position = await invoke<{ x: number; y: number }>("clamp_context_menu_position", {
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height,
  }).then(({ x: positionX, y: positionY }) => new PhysicalPosition(positionX, positionY))
    .catch(() => new PhysicalPosition(Math.round(x), Math.round(y)));
  await menuWindow.setPosition(position).catch(() => undefined);
  await menuWindow.show().catch(() => undefined);
  await menuWindow.setFocus().catch(() => undefined);
};
