import fs from 'fs';
import path from 'path';
import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import type { MountAllowlist, AdditionalMount } from './types.js';

const DEFAULT_BLOCKED_PATTERNS = [
  '**/.env',
  '**/.env.*',
  '**/node_modules',
  '**/.git',
  '**/secrets',
  '**/*.key',
  '**/*.pem',
];

/** Load the mount allowlist from config, or return defaults. */
export function loadMountAllowlist(): MountAllowlist {
  try {
    if (fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      const raw = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as MountAllowlist;
      return {
        allowedRoots: parsed.allowedRoots ?? [],
        blockedPatterns: [
          ...DEFAULT_BLOCKED_PATTERNS,
          ...(parsed.blockedPatterns ?? []),
        ],
        nonMainReadOnly: parsed.nonMainReadOnly ?? true,
      };
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load mount allowlist');
  }

  return {
    allowedRoots: [],
    blockedPatterns: DEFAULT_BLOCKED_PATTERNS,
    nonMainReadOnly: true,
  };
}

/** Validate a mount request against the allowlist. */
export function validateMount(
  mount: AdditionalMount,
  allowlist: MountAllowlist,
  isMain: boolean,
): { allowed: boolean; reason?: string } {
  const resolved = path.resolve(mount.hostPath);

  // Check blocked patterns
  for (const pattern of allowlist.blockedPatterns) {
    if (resolved.includes(pattern.replace(/\*\*/g, ''))) {
      return {
        allowed: false,
        reason: `Path matches blocked pattern: ${pattern}`,
      };
    }
  }

  // Check if path is under an allowed root
  const matchedRoot = allowlist.allowedRoots.find((root) =>
    resolved.startsWith(path.resolve(root.path)),
  );

  if (!matchedRoot) {
    return {
      allowed: false,
      reason: `Path not under any allowed root: ${resolved}`,
    };
  }

  // Non-main groups get read-only access unless explicitly allowed
  if (!isMain && allowlist.nonMainReadOnly && !mount.readonly) {
    if (!matchedRoot.allowReadWrite) {
      return {
        allowed: false,
        reason: 'Non-main groups only get read-only access to this root',
      };
    }
  }

  return { allowed: true };
}
