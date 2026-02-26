/**
 * Maps file paths/extensions to icon filenames in assets/extension_icons.
 * Icons: 01_hex, 02_vscode, 03_npm, 04_braces, 05_play, 06_braces_alt, 07_octopus,
 * 08-11_whale*, 12_astronaut, 13_ts, 14_ts_alt, 15_js, 16_braces_2, 17_braces_3,
 * 18_js_alt, 19_down, 20_info, 21_ts_2, 22_ts_box, 23_braces_last, 24_react.
 */

const EXT_TO_ICON: Record<string, string> = {
  ts: "13_ts.png",
  tsx: "24_react.png",
  js: "15_js.png",
  jsx: "24_react.png",
  mjs: "15_js.png",
  cjs: "15_js.png",
  json: "04_braces.png",
  html: "26_html_chevrons.png",
  htm: "26_html_chevrons.png",
  css: "25_css_hash.png",
  scss: "25_css_hash.png",
  md: "20_info.png",
  mdx: "20_info.png",
  py: "12_astronaut.png",
  yaml: "02_vscode.png",
  yml: "02_vscode.png",
  env: "02_vscode.png",
  lock: "03_npm.png",
};

const BASENAME_TO_ICON: Record<string, string> = {
  "package.json": "03_npm.png",
  "package-lock.json": "03_npm.png",
  "tsconfig.json": "13_ts.png",
  "vite.config.ts": "13_ts.png",
  "vite.config.js": "15_js.png",
  "README.md": "20_info.png",
};

const DEFAULT_ICON = "01_hex.png";

export function getExtensionIcon(path: string): string {
  const base = path.replace(/^.*[/\\]/, "");
  const known = BASENAME_TO_ICON[base];
  if (known) return known;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  return EXT_TO_ICON[ext] ?? DEFAULT_ICON;
}

const iconModules = import.meta.glob<{ default: string }>(
  "../assets/extension_icons/*.png",
  { eager: true, query: "?url", import: "default" }
);

const ICON_URLS: Record<string, string> = {};
for (const [modulePath, mod] of Object.entries(iconModules)) {
  const name = modulePath.replace(/^.*\//, "");
  ICON_URLS[name] = typeof mod === "object" && mod && "default" in mod ? mod.default : String(mod);
}

export function getExtensionIconUrl(path: string): string {
  const filename = getExtensionIcon(path);
  return ICON_URLS[filename] ?? ICON_URLS[DEFAULT_ICON] ?? "";
}
