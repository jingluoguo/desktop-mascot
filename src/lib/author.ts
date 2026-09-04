import { openUrl } from "@tauri-apps/plugin-opener";
import { AUTHOR_DATA_CACHE_KEY } from "../config";
import type { AuthorData, AuthorLink, AuthorTag, AuthorWork } from "../types";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown) => typeof value === "string" ? value.trim() : "";
const booleanValue = (value: unknown) => typeof value === "boolean" ? value : undefined;
const isExternalUrl = (value: string) => {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
const parseAuthorData = (value: unknown): AuthorData | null => {
  if (!isRecord(value) || !isRecord(value.author)) return null;
  const author = value.author;
  const id = stringValue(author.id);
  const name = stringValue(author.name);
  if (!id || !name) return null;

  const links = Array.isArray(author.links)
    ? author.links.flatMap<AuthorLink>((item) => {
      if (!isRecord(item)) return [];
      const label = stringValue(item.label);
      const url = stringValue(item.url);
      return label && isExternalUrl(url) ? [{ label, url }] : [];
    })
    : [];
  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap<AuthorTag>((item) => {
      if (!isRecord(item)) return [];
      const tag = { id: stringValue(item.id), name: stringValue(item.name), color: stringValue(item.color) };
      return tag.id && tag.name ? [tag] : [];
    })
    : [];
  const works = (Array.isArray(value.works)
    ? value.works.flatMap<AuthorWork>((item) => {
      if (!isRecord(item)) return [];
      const workId = stringValue(item.id);
      const title = stringValue(item.title);
      const status = booleanValue(item.status) ?? false;
      if (!workId || !title || !status) return [];
      const link = stringValue(item.link);
      const cover = stringValue(item.cover);
      const workTags = Array.isArray(item.tags) ? item.tags.map(stringValue).filter(Boolean) : [];
      return [{
        id: workId,
        type: stringValue(item.type),
        version: stringValue(item.version),
        title,
        description: stringValue(item.description),
        link: isExternalUrl(link) ? link : "",
        cover: isExternalUrl(cover) ? cover : "",
        tags: workTags,
        status,
        featured: booleanValue(item.featured) ?? false,
        releasedAt: stringValue(item.releasedAt),
      }];
    })
    : []).sort((first, second) => Number(second.featured) - Number(first.featured));

  const avatar = stringValue(author.avatar);
  return {
    schemaVersion: stringValue(value.schemaVersion),
    updatedAt: stringValue(value.updatedAt),
    author: {
      id,
      name,
      bio: stringValue(author.bio),
      avatar: isExternalUrl(avatar) ? avatar : "",
      links,
    },
    tags,
    works,
  };
};
const loadCachedAuthorData = () => {
  try {
    return parseAuthorData(JSON.parse(localStorage.getItem(AUTHOR_DATA_CACHE_KEY) ?? "null"));
  } catch {
    return null;
  }
};
const openExternalUrl = (url: string) => {
  if (!isExternalUrl(url)) return;
  void openUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
};
export { isRecord, parseAuthorData, loadCachedAuthorData, openExternalUrl };
