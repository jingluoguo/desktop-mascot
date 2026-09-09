import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { shortcutDisplay } from "../lib/settings";
import { getLivelyMascot } from "../lib/mascotRuntime";

type ContextMenuState = {
  hasAccessories: boolean;
  globalShortcut: string;
  dashboardShortcut: string;
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
  const quickEmotions = useMemo(() => Object.values(getLivelyMascot().emotions).sort((a, b) => {
    const numericDifference = Number(a.id) - Number(b.id);
    return Number.isNaN(numericDifference) ? a.id.localeCompare(b.id) : numericDifference;
  }), []);
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
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const resizeWindow = async () => {
      const height = Math.ceil(menu.getBoundingClientRect().height);
      if (height === lastMenuHeightRef.current) return;
      lastMenuHeightRef.current = height;

      const menuWindow = getCurrentWindow();
      await menuWindow.setSize(new LogicalSize(220, height)).catch(() => undefined);

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
  }, [hasAccessories, shortcuts]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ContextMenuState>("mascot-context-menu-state", ({ payload }) => {
      setHasAccessories(payload.hasAccessories);
      setShortcuts({ globalShortcut: payload.globalShortcut, dashboardShortcut: payload.dashboardShortcut });
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
    <div className="menu-section" aria-label="快捷反应">
      <div className="quick-reaction-heading">
        <span>快捷反应</span>
        <div className="quick-reaction-nav" aria-label="滚动快捷反应">
          <button type="button" aria-label="向左滚动" onClick={() => scrollQuickReactions(-1)}>‹</button>
          <button type="button" aria-label="向右滚动" onClick={() => scrollQuickReactions(1)}>›</button>
        </div>
      </div>
      <div ref={quickReactionScrollRef} className="quick-reaction-scroll">
        <div className="quick-reaction-actions">
          {quickEmotions.map((emotion) => <button key={emotion.id} type="button" role="menuitem" title={emotion.desc} onClick={() => void triggerEmotion(emotion.id)}><span>{emotion.desc}</span></button>)}
        </div>
      </div>
      {hasAccessories && <button type="button" role="menuitem" className="quick-accessory" onClick={async () => { await emitTo("main", "mascot-toggle-accessory"); await close(); }}><span>切换配件</span><small>⌥</small></button>}
    </div>
    <div className="menu-actions">
      <button type="button" role="menuitem" onClick={async () => { await emitTo("main", "open-settings"); await close(); }}><span>仪表盘</span>{shortcuts.dashboardShortcut && <small>{shortcutDisplay(shortcuts.dashboardShortcut)}</small>}</button>
      <button type="button" role="menuitem" onClick={async () => { await invoke("hide_main_window").catch(() => undefined); await close(); }}><span>隐藏</span>{shortcuts.globalShortcut && <small>{shortcutDisplay(shortcuts.globalShortcut)}</small>}</button>
      <button type="button" role="menuitem" className="menu-danger" onClick={() => { void invoke("quit_app").catch(() => undefined); }}><span>退出</span></button>
    </div>
  </div></main>;
}
