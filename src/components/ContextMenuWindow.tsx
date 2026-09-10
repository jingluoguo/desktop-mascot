import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { CONTEXT_MENU_WIDTH, uiText } from "../config";
import { loadDashboardPreferences, shortcutDisplay } from "../lib/settings";
import { getLivelyMascot } from "../lib/mascotRuntime";
import type { DashboardLocale, DashboardTheme } from "../types";

type ContextMenuState = {
  hasAccessories: boolean;
  globalShortcut: string;
  dashboardShortcut: string;
  locale: DashboardLocale;
  theme: DashboardTheme;
};

export function ContextMenuWindow() {
  const menuRef = useRef<HTMLDivElement>(null);
  const quickReactionScrollRef = useRef<HTMLDivElement>(null);
  const lastMenuHeightRef = useRef(0);
  const [hasAccessories, setHasAccessories] = useState(false);
  const [shortcuts, setShortcuts] = useState<Pick<ContextMenuState, "globalShortcut" | "dashboardShortcut">>({
    globalShortcut: "",
    dashboardShortcut: "",
  });
  const [locale, setLocale] = useState(() => loadDashboardPreferences().locale);
  const [theme, setTheme] = useState(() => loadDashboardPreferences().theme);
  const copy = uiText[locale];
  const quickEmotions = useMemo(() => Object.values(getLivelyMascot().emotions).sort((a, b) => {
    const numericDifference = Number(a.id) - Number(b.id);
    return Number.isNaN(numericDifference) ? a.id.localeCompare(b.id) : numericDifference;
  }), []);
  const emotionLabel = (emotion: { id: string; name?: string; desc?: string }) => (
    locale === "zh-CN" ? emotion.desc || emotion.name || emotion.id : emotion.name || emotion.desc || emotion.id
  );
  const close = async () => {
    await getCurrentWindow().close().catch(() => undefined);
  };
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.classList.toggle("theme-light", theme === "light");
  }, [locale, theme]);
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
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const resizeWindow = async () => {
      const height = Math.ceil(menu.getBoundingClientRect().height);
      if (height === lastMenuHeightRef.current) return;
      lastMenuHeightRef.current = height;

      const menuWindow = getCurrentWindow();
      await menuWindow.setSize(new LogicalSize(CONTEXT_MENU_WIDTH, height)).catch(() => undefined);

      const [position, size] = await Promise.all([
        menuWindow.outerPosition(),
        menuWindow.outerSize(),
      ]).catch(() => [null, null] as const);
      if (!position || !size) return;

      const clamped = await invoke<{ x: number; y: number }>("clamp_context_menu_position", {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      }).catch(() => null);
      if (clamped) await menuWindow.setPosition(new PhysicalPosition(clamped.x, clamped.y)).catch(() => undefined);
    };

    const observer = new ResizeObserver(() => { void resizeWindow(); });
    observer.observe(menu);
    void resizeWindow();
    return () => observer.disconnect();
  }, [hasAccessories, shortcuts, locale]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ContextMenuState>("mascot-context-menu-state", ({ payload }) => {
      setHasAccessories(payload.hasAccessories);
      setShortcuts({ globalShortcut: payload.globalShortcut, dashboardShortcut: payload.dashboardShortcut });
      if (payload.locale) setLocale(payload.locale);
      if (payload.theme) setTheme(payload.theme);
    })
      .then((dispose) => {
        unlisten = dispose;
        void emitTo("main", "mascot-context-menu-request");
      });
    return () => unlisten?.();
  }, []);
  const triggerEmotion = async (emotion: string) => {
    await emitTo("main", "mascot-quick-emotion", { emotion });
    await close();
  };
  const scrollQuickReactions = (direction: number) => {
    quickReactionScrollRef.current?.scrollBy({ left: direction * 132, behavior: "smooth" });
  };
  return <main className="context-menu-window"><div ref={menuRef} className="pet-menu" role="menu">
    <div className="menu-section" aria-label={copy.quickInteractions}>
      <div className="quick-reaction-heading">
        <span>{copy.quickInteractions}</span>
        <div className="quick-reaction-nav" aria-label={copy.scrollQuickReactions}>
          <button type="button" aria-label={copy.scrollLeft} onClick={() => scrollQuickReactions(-1)}>‹</button>
          <button type="button" aria-label={copy.scrollRight} onClick={() => scrollQuickReactions(1)}>›</button>
        </div>
      </div>
      <div ref={quickReactionScrollRef} className="quick-reaction-scroll">
        <div className="quick-reaction-actions">
          {quickEmotions.map((emotion) => {
            const label = emotionLabel(emotion);
            return <button key={emotion.id} type="button" role="menuitem" title={label} onClick={() => void triggerEmotion(emotion.id)}><span>{label}</span></button>;
          })}
        </div>
      </div>
      {hasAccessories && <button type="button" role="menuitem" className="quick-accessory" onClick={async () => { await emitTo("main", "mascot-toggle-accessory"); await close(); }}><span>{copy.toggleAccessory}</span><small>⌥</small></button>}
    </div>
    <div className="menu-actions">
      <button type="button" role="menuitem" onClick={async () => { await emitTo("main", "open-settings"); await close(); }}><span>{copy.dashboardLabel}</span>{shortcuts.dashboardShortcut && <small>{shortcutDisplay(shortcuts.dashboardShortcut)}</small>}</button>
      <button type="button" role="menuitem" onClick={async () => { await invoke("hide_main_window").catch(() => undefined); await close(); }}><span>{copy.hidePet}</span>{shortcuts.globalShortcut && <small>{shortcutDisplay(shortcuts.globalShortcut)}</small>}</button>
      <button type="button" role="menuitem" className="menu-danger" onClick={() => { void invoke("quit_app").catch(() => undefined); }}><span>{copy.quitApp}</span></button>
    </div>
  </div></main>;
}
