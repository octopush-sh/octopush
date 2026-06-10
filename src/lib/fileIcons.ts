import {
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  type LucideIcon,
} from "lucide-react";

const CODE = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "java", "py", "go", "rb", "c",
  "h", "cpp", "hpp", "cc", "cs", "swift", "kt", "kts", "php", "sql", "html",
  "css", "scss", "less", "vue", "svelte",
]);
const DATA = new Set(["json", "yaml", "yml", "toml", "xml", "csv"]);
const TEXT = new Set(["md", "mdx", "txt", "rtf", "log"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "war", "jar", "ear"]);
const SHELL = new Set(["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"]);
const CONFIG = new Set([
  "env", "ini", "conf", "cfg", "properties", "gitignore", "gitattributes",
  "editorconfig", "dockerignore", "npmrc", "nvmrc",
]);
const LOCKFILE_NAMES = new Set(["cargo.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

/** Map a file name to its lucide icon component. Pure; safe to call per row. */
export function fileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (LOCKFILE_NAMES.has(lower)) return FileLock;
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : "";
  if (CODE.has(ext)) return FileCode;
  if (DATA.has(ext)) return FileJson;
  if (TEXT.has(ext)) return FileText;
  if (IMAGE.has(ext)) return FileImage;
  if (ARCHIVE.has(ext)) return FileArchive;
  if (SHELL.has(ext)) return FileTerminal;
  if (CONFIG.has(ext)) return FileCog;
  if (ext === "lock") return FileLock;
  return File;
}
