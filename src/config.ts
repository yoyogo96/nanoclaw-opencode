import path from 'path';
import os from 'os';
import { readEnvFile } from './env.js';

const env = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'MAX_CONCURRENT_CONTAINERS',
  'IPC_POLL_INTERVAL',
  'IDLE_TIMEOUT',
  'OPENCODE_MODEL',
  'TZ',
]);

// ── Assistant ──────────────────────────────────────────────
export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME ?? env.ASSISTANT_NAME ?? 'Andy';

export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ?? env.ASSISTANT_HAS_OWN_NUMBER) ===
  'true';

// ── Polling ────────────────────────────────────────────────
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60_000;

// ── Paths ──────────────────────────────────────────────────
export const PROJECT_ROOT = process.cwd();
export const HOME_DIR = os.homedir();
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.join(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');

// ── Container ──────────────────────────────────────────────
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE ?? env.CONTAINER_IMAGE ?? 'nanoclaw-agent:latest';

export const CONTAINER_TIMEOUT = Number(
  process.env.CONTAINER_TIMEOUT ?? env.CONTAINER_TIMEOUT ?? 1_800_000,
);

export const CONTAINER_MAX_OUTPUT_SIZE = Number(
  process.env.CONTAINER_MAX_OUTPUT_SIZE ??
    env.CONTAINER_MAX_OUTPUT_SIZE ??
    10_485_760,
);

export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  Number(
    process.env.MAX_CONCURRENT_CONTAINERS ??
      env.MAX_CONCURRENT_CONTAINERS ??
      5,
  ),
);

export const IPC_POLL_INTERVAL = Number(
  process.env.IPC_POLL_INTERVAL ?? env.IPC_POLL_INTERVAL ?? 1000,
);

export const IDLE_TIMEOUT = Number(
  process.env.IDLE_TIMEOUT ?? env.IDLE_TIMEOUT ?? 1_800_000,
);

// ── OpenCode ───────────────────────────────────────────────
export const OPENCODE_MODEL =
  process.env.OPENCODE_MODEL ??
  env.OPENCODE_MODEL ??
  'anthropic/claude-sonnet-4-20250514';

// ── Trigger ────────────────────────────────────────────────
export const TRIGGER_PATTERN = new RegExp(
  `@${ASSISTANT_NAME}\\b`,
  'i',
);

// ── Timezone ───────────────────────────────────────────────
export const TIMEZONE =
  process.env.TZ ??
  env.TZ ??
  Intl.DateTimeFormat().resolvedOptions().timeZone;
