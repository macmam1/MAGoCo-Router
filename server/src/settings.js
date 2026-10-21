// Settings: the values the dashboard writes, typed and applied.
//
// Every setting lives in the database, so it survives a restart and can be
// changed without touching the environment.
import { getSettings, updateSettings } from "./db.js";

const DEFAULTS = {
  defaultStrategy: "priority",
  autoFailover: true,
  relayContext: true,
  cacheEnabled: true,
  cacheTtlMs: 300000,
  breakerThreshold: 3,
  breakerCooldownMs: 60000,
  modelLockoutMs: 300000,
  registrySyncEnabled: true,
  registrySyncIntervalMs: 3600000,
  backupIntervalMs: 21600000,
  usageRetentionDays: 30,
  telegramModel: "beam-free",
  defaultCombo: "",
};

export function getSetting(key) {
  const s = getSettings();
  if (s[key] !== undefined && s[key] !== null && s[key] !== "") return s[key];
  return DEFAULTS[key];
}

export function numberSetting(key) {
  const value = Number(getSetting(key));
  return Number.isFinite(value) ? value : DEFAULTS[key];
}

export function boolSetting(key) {
  const value = getSetting(key);
  if (typeof value === "boolean") return value;
  return String(value) === "true" || value === 1;
}

export function allSettings() {
  const s = getSettings();
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    out[key] = s[key] === undefined || s[key] === "" ? fallback : s[key];
  }
  for (const [key, value] of Object.entries(s)) {
    if (key.startsWith("__")) continue;
    if (!(key in out)) out[key] = key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") ? "•••" : value;
  }
  return out;
}

export function saveSettings(patch) {
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key.startsWith("__")) continue;
    if (key in DEFAULTS) {
      clean[key] = typeof DEFAULTS[key] === "boolean" ? (value === true || value === "true" ? "true" : "false") : value;
    } else {
      clean[key] = value;
    }
  }
  updateSettings(clean);
  return allSettings();
}

export { DEFAULTS };
