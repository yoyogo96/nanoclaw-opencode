import fs from 'fs';
import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

interface SenderAllowlist {
  enabled: boolean;
  allowedSenders: string[];
}

let allowlist: SenderAllowlist | null = null;

/** Load the sender allowlist from config. */
function loadAllowlist(): SenderAllowlist {
  if (allowlist) return allowlist;

  try {
    if (fs.existsSync(SENDER_ALLOWLIST_PATH)) {
      const raw = fs.readFileSync(SENDER_ALLOWLIST_PATH, 'utf-8');
      allowlist = JSON.parse(raw) as SenderAllowlist;
      logger.info(
        { count: allowlist.allowedSenders.length },
        'Loaded sender allowlist',
      );
      return allowlist;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load sender allowlist');
  }

  allowlist = { enabled: false, allowedSenders: [] };
  return allowlist;
}

/** Check whether a sender JID is allowed to interact. */
export function isSenderAllowed(senderJid: string): boolean {
  const list = loadAllowlist();
  if (!list.enabled) return true;
  return list.allowedSenders.some(
    (allowed) =>
      senderJid === allowed || senderJid.startsWith(allowed + '@'),
  );
}

/** Reload the allowlist from disk (e.g., after config change). */
export function reloadAllowlist(): void {
  allowlist = null;
  loadAllowlist();
}
