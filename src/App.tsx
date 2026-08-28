import { useEffect, useRef, useState } from "react";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import type { createMascot as CreateMascot, MascotInstance } from "lively-mascot";
import "lively-mascot/dist/lively-mascot.min.js";
import "lively-mascot/dist/lively-mascot.min.css";
import "./App.css";

type LivelyMascotApi = { createMascot: typeof CreateMascot };
const getLivelyMascot = () => (window as Window & { LivelyMascot?: LivelyMascotApi }).LivelyMascot;

const moods = [
  { id: "02", label: "平静", detail: "安静漂浮" },
  { id: "10", label: "开心", detail: "给你一点能量" },
  { id: "20", label: "思考", detail: "整理你的想法" },
  { id: "28", label: "加载", detail: "马上回来" },
  { id: "35", label: "难过", detail: "需要一个拥抱" },
  { id: "39", label: "等待", detail: "留在这里陪你" },
];

function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<MascotInstance | null>(null);
  const happyResetTimerRef = useRef<number | null>(null);
  const pointerPollBusyRef = useRef(false);
  const [activeMood, setActiveMood] = useState("02");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 20, y: 20 });
  const selectedMood = moods.find((mood) => mood.id === activeMood) ?? moods[0];

  const triggerHappy = () => {
    if (happyResetTimerRef.current !== null) window.clearTimeout(happyResetTimerRef.current);
    setActiveMood("10");
    happyResetTimerRef.current = window.setTimeout(() => {
      setActiveMood("02");
      happyResetTimerRef.current = null;
    }, 2200);
  };

  useEffect(() => {
    if (!hostRef.current) return;
    const livelyMascot = getLivelyMascot();
    if (!livelyMascot) return;
    const mascot = livelyMascot.createMascot(hostRef.current, {
      type: "ghost",
      size: 260,
      color: "#9de8ff",
      outline: "#132238",
      accent: "#ff9fb6",
      viewMode: "3d",
      followCursor: true,
      hopInterval: null,
      onClick: triggerHappy,
    });
    mascotRef.current = mascot;
    mascot.setEmotion(activeMood);
    const appWindow = getCurrentWindow();
    const pointerPoll = window.setInterval(async () => {
      if (pointerPollBusyRef.current) return;
      pointerPollBusyRef.current = true;
      try {
        const [cursor, windowPosition, scaleFactor] = await Promise.all([
          cursorPosition(),
          appWindow.outerPosition(),
          appWindow.scaleFactor(),
        ]);
        const clientX = (cursor.x - windowPosition.x) / scaleFactor;
        const clientY = (cursor.y - windowPosition.y) / scaleFactor;
        window.dispatchEvent(new PointerEvent("pointermove", {
          bubbles: true,
          clientX,
          clientY,
          pointerId: 1,
          pointerType: "mouse",
        }));
      } catch {
        // The browser preview does not expose native cursor coordinates.
      } finally {
        pointerPollBusyRef.current = false;
      }
    }, 50);
    return () => {
      window.clearInterval(pointerPoll);
      mascot.destroy();
      mascotRef.current = null;
      if (happyResetTimerRef.current !== null) window.clearTimeout(happyResetTimerRef.current);
    };
    // The mascot instance is intentionally created once per window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mascotRef.current?.setEmotion(activeMood);
  }, [activeMood]);

  const startDragging = async (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (menuOpen) setMenuOpen(false);
    try {
      await getCurrentWindow().startDragging();
    } catch {
      // Browser preview does not expose the Tauri window API.
    }
  };

  const openContextMenu = (event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setMenuPosition({
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 202)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 218)),
    });
    setMenuOpen(true);
  };

  return (
    <main className="pet-window" onPointerDown={startDragging} onContextMenu={openContextMenu}>
      <div ref={hostRef} className="pet-host" aria-label="可拖拽的幽灵宠物" />

      {menuOpen && (
        <div className="pet-menu" style={{ left: menuPosition.x, top: menuPosition.y }} onPointerDown={(event) => event.stopPropagation()}>
          <div className="menu-header"><span>幽灵情绪 · {selectedMood.label}</span><span className="menu-count">{moods.length}</span></div>
          <div className="mood-grid">
            {moods.map((mood) => (
              <button key={mood.id} type="button" className={activeMood === mood.id ? "selected" : ""} onClick={() => { mood.id === "10" ? triggerHappy() : setActiveMood(mood.id); setMenuOpen(false); }}>
                <span>{mood.label}</span><small>{mood.id}</small>
              </button>
            ))}
          </div>
          <button className="quit-button" type="button" onClick={() => { void getCurrentWindow().close(); }}>退出宠物</button>
        </div>
      )}
    </main>
  );
}

export default App;
