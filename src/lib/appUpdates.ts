import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { AUTHOR_DATA_URL } from "../config";
import type { AppUpdateStatus } from "../types";
import { parseAuthorData } from "./author";

const DESKTOP_MASCOT_REPOSITORY = "https://github.com/jingluoguo/desktop-mascot";

const versionParts = (version: string) => version.trim().replace(/^v/i, "").split(/[.-]/).map((part) => /^\d+$/.test(part) ? Number(part) : 0);

const isNewerVersion = (candidate: string, current: string) => {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  const length = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (candidateParts[index] ?? 0) - (currentParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

const checkForAppUpdate = async (): Promise<AppUpdateStatus> => {
  const [response, currentVersion] = await Promise.all([
    fetch(AUTHOR_DATA_URL, { cache: "no-store" }),
    getVersion(),
  ]);
  if (!response.ok) throw new Error(`Author data request failed with ${response.status}`);
  const authorData = parseAuthorData(await response.json());
  if (!authorData) throw new Error("Author data does not match the supported schema");
  const release = authorData.works.find((work) => work.id === "desktop_mascot" || work.id === "desktop-mascot" || work.link.replace(/\/$/, "") === DESKTOP_MASCOT_REPOSITORY);
  if (!release || !isNewerVersion(release.version, currentVersion)) {
    return invoke<AppUpdateStatus>("mark_up_to_date");
  }
  return invoke<AppUpdateStatus>("check_for_update");
};

export { checkForAppUpdate, isNewerVersion };
