import { useEffect, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
export function ContextMenuWindow() {
  const [hasAccessories, setHasAccessories] = useState(false);
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
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ hasAccessories: boolean }>("mascot-context-menu-state", ({ payload }) => setHasAccessories(payload.hasAccessories))
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
  return <main className="context-menu-window"><div className="pet-menu" role="menu">
    <div className="menu-section" aria-label="快捷反应">
      <span>快捷反应</span>
      <div className="quick-reaction-actions">
        <button type="button" role="menuitem" title="开心" onClick={() => void triggerEmotion("10")}>开心</button>
        <button type="button" role="menuitem" title="好奇" onClick={() => void triggerEmotion("11")}>好奇</button>
        <button type="button" role="menuitem" title="心动" onClick={() => void triggerEmotion("16")}>心动</button>
      </div>
      {hasAccessories && <button type="button" role="menuitem" className="quick-accessory" onClick={async () => { await emitTo("main", "mascot-toggle-accessory"); await close(); }}><span>切换配件</span><small>⌥</small></button>}
    </div>
    <div className="menu-actions">
      <button type="button" role="menuitem" onClick={async () => { await emitTo("main", "open-settings"); await close(); }}><span>仪表盘</span><small>⌘</small></button>
      <button type="button" role="menuitem" onClick={async () => { await invoke("hide_main_window").catch(() => undefined); await close(); }}><span>隐藏</span><small>H</small></button>
      <button type="button" role="menuitem" className="menu-danger" onClick={() => { void invoke("quit_app").catch(() => undefined); }}><span>退出</span><small>Q</small></button>
    </div>
  </div></main>;
}
