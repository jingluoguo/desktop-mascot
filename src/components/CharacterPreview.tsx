import { useEffect, useRef } from "react";
import { defaultThemes } from "../config";
import type { MascotSettings } from "../types";
import { getLivelyMascot } from "../lib/mascotRuntime";
export function CharacterPreview({ character, settings, emotion = "02", size = 36, className = "" }: { character: string; settings: MascotSettings; emotion?: string; size?: number; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const previewTheme = character === settings.character ? settings : { ...settings, character, ...defaultThemes[character] };

  useEffect(() => {
    if (!hostRef.current) return;
    const livelyMascot = getLivelyMascot();
    if (!livelyMascot) return;
    const mascot = livelyMascot.createMascot(hostRef.current, {
      type: character,
      size,
      color: previewTheme.bodyColor,
      outline: previewTheme.outlineColor,
      accent: previewTheme.accentColor,
      viewMode: settings.viewMode,
      outlineVisible: settings.outlineVisible,
      followCursor: false,
      hopInterval: null,
      animated: false,
    });
    mascot.setFaceVariant(settings.faceVariant);
    const modelAccessories = livelyMascot.models[character]?.accessories ?? {};
    Object.entries(modelAccessories).forEach(([id, definition]) => {
      const enabled = settings.accessories[`${character}:${id}`] ?? definition.default;
      mascot.setAccessory(id, enabled);
    });
    mascot.setEmotion(emotion);
    return () => mascot.destroy();
  }, [character, emotion, size, previewTheme.bodyColor, previewTheme.outlineColor, previewTheme.accentColor, settings.viewMode, settings.outlineVisible, settings.faceVariant, settings.accessories]);

  return <div ref={hostRef} className={`character-thumb-host ${className}`} aria-hidden="true" />;
}

