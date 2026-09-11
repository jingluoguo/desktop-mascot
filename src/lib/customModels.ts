import { invoke } from "@tauri-apps/api/core";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { UiCopy } from "../config";
import type { CustomModelSources, CustomModelSummary, InteractionCapabilities, InteractionTrigger } from "../types";
import { getLivelyMascot } from "./mascotRuntime";

const loadCustomModels = async (): Promise<CustomModelSummary[]> => {
  const summaries = await invoke<CustomModelSummary[]>("list_custom_models");
  const modelApi = getLivelyMascot();
  const activeIds = new Set(summaries.map((summary) => summary.id));
  document.querySelectorAll<HTMLElement>("[data-lively-custom-model]").forEach((element) => {
    const id = element.dataset.livelyCustomModel;
    if (id && !activeIds.has(id)) {
      element.remove();
      if (modelApi?.models) delete modelApi.models[id];
    }
  });
  const loadedSummaries: CustomModelSummary[] = [];
  for (const summary of summaries) {
    try {
      const sources = await invoke<CustomModelSources>("read_custom_model", { id: summary.id });
      const styleId = `lively-custom-model-css-${summary.id}`;
      const scriptId = `lively-custom-model-js-${summary.id}`;
      document.getElementById(styleId)?.remove();
      document.getElementById(scriptId)?.remove();
      const style = document.createElement("style");
      style.id = styleId;
      style.dataset.livelyCustomModel = summary.id;
      style.textContent = sources.model_css;
      document.head.appendChild(style);
      const script = document.createElement("script");
      script.id = scriptId;
      script.dataset.livelyCustomModel = summary.id;
      script.text = sources.model_js;
      document.head.appendChild(script);
      const registeredModel = getLivelyMascot()?.models?.[summary.id];
      if (!registeredModel) throw new Error("model script did not register its manifest id");
      registeredModel.interactions = interactionCapabilitiesFromManifest(sources.model_json);
      loadedSummaries.push(summary);
    } catch {
      document.getElementById(`lively-custom-model-css-${summary.id}`)?.remove();
      document.getElementById(`lively-custom-model-js-${summary.id}`)?.remove();
      if (modelApi?.models) delete modelApi.models[summary.id];
    }
  }
  return loadedSummaries;
};

const interactionTriggers: InteractionTrigger[] = ["click", "doubleClick", "hover", "drag"];

const interactionCapabilitiesFromManifest = (source: string): InteractionCapabilities | undefined => {
  try {
    const interactions = (JSON.parse(source) as { interactions?: unknown }).interactions;
    if (!interactions || typeof interactions !== "object" || Array.isArray(interactions)) return undefined;
    const capabilities = Object.fromEntries(interactionTriggers.flatMap((trigger) => {
      const actions = (interactions as Record<string, unknown>)[trigger];
      if (!Array.isArray(actions)) return [];
      const supported = actions.filter((action): action is string => typeof action === "string" && action.length > 0 && action.length <= 40);
      return supported.length > 0 ? [[trigger, supported]] : [];
    })) as InteractionCapabilities;
    return Object.keys(capabilities).length > 0 ? capabilities : undefined;
  } catch {
    return undefined;
  }
};

const MODEL_PACKAGE_EXTENSION = ".livelymodel";
const MODEL_FILE_NAMES = ["model.js", "model.css", "model.json"] as const;
type ModelFilePayload = { id: string; model_js: string; model_css: string; model_json: string };

const modelFilesFromSelection = async (files: File[]): Promise<ModelFilePayload> => {
  const entries = new Map<string, string>();
  for (const file of files) {
    if (file.name.toLowerCase().endsWith(MODEL_PACKAGE_EXTENSION)) {
      const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
      Object.entries(archive).forEach(([name, content]) => {
        const baseName = name.split("/").pop()?.toLowerCase() ?? "";
        if (MODEL_FILE_NAMES.includes(baseName as typeof MODEL_FILE_NAMES[number])) entries.set(baseName, strFromU8(content));
      });
    } else {
      const baseName = file.name.split("/").pop()?.toLowerCase() ?? "";
      if (MODEL_FILE_NAMES.includes(baseName as typeof MODEL_FILE_NAMES[number])) entries.set(baseName, await file.text());
    }
  }
  const missing = MODEL_FILE_NAMES.filter((name) => !entries.has(name));
  if (missing.length > 0) throw new Error(`Missing model files: ${missing.join(", ")}`);
  const manifest = JSON.parse(entries.get("model.json") ?? "") as { id?: unknown; formatVersion?: unknown };
  if (manifest.formatVersion !== undefined && manifest.formatVersion !== 1) throw new Error("Unsupported model package version");
  if (typeof manifest.id !== "string" || !/^[a-z0-9_-]+$/i.test(manifest.id)) throw new Error("Invalid model id");
  return { id: manifest.id, model_js: entries.get("model.js") ?? "", model_css: entries.get("model.css") ?? "", model_json: entries.get("model.json") ?? "" };
};

const modelImportErrorText = (error: unknown, text: UiCopy) => {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("unsupported") || message.includes("version")) return text.modelImportUnsupported;
  if (message.includes("large") || message.includes("2 mb")) return text.modelImportTooLarge;
  if (message.includes("forbidden") || message.includes("remote") || message.includes("blocked")) return text.modelImportUnsafe;
  return text.modelImportInvalid;
};

const modelPackageBlob = (sources: CustomModelSources, manifestJson = sources.model_json) => new Blob([
  zipSync({
    "model.js": strToU8(sources.model_js),
    "model.css": strToU8(sources.model_css),
    "model.json": strToU8(manifestJson),
  }),
], { type: "application/vnd.lively-mascot.model+zip" });

const downloadModelPackage = async (id: string) => {
  const sources = await invoke<CustomModelSources>("read_custom_model", { id });
  const manifest = JSON.parse(sources.model_json) as Record<string, unknown>;
  manifest.formatVersion = 1;
  const url = URL.createObjectURL(modelPackageBlob(sources, JSON.stringify(manifest, null, 2)));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${id}${MODEL_PACKAGE_EXTENSION}`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export { loadCustomModels, modelFilesFromSelection, modelImportErrorText, downloadModelPackage };
export type { ModelFilePayload };
