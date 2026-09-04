import { useEffect } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
export function ContextMenuWindow() {
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

