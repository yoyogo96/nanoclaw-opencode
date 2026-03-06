import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';

const VALID_FOLDER_RE = /^[a-zA-Z0-9_-]+$/;

/** Validate a group folder name — no path traversal allowed. */
export function isValidGroupFolder(name: string): boolean {
  return VALID_FOLDER_RE.test(name) && !name.includes('..');
}

/** Ensure the group directory and its AGENTS.md file exist. */
export function ensureGroupFolder(folderName: string): string {
  if (!isValidGroupFolder(folderName)) {
    throw new Error(`Invalid group folder name: ${folderName}`);
  }

  const groupDir = path.join(GROUPS_DIR, folderName);
  fs.mkdirSync(groupDir, { recursive: true });

  // Create per-group AGENTS.md if it doesn't exist (replaces CLAUDE.md)
  const agentsMd = path.join(groupDir, 'AGENTS.md');
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(
      agentsMd,
      `# ${folderName} Group Instructions\n\nYou are assisting the "${folderName}" group. Respond helpfully and concisely.\n`,
    );
    logger.info({ folder: folderName }, 'Created AGENTS.md for group');
  }

  // Create per-group .opencode directory
  const opencodeDir = path.join(groupDir, '.opencode');
  fs.mkdirSync(opencodeDir, { recursive: true });

  // Create per-group opencode.json if it doesn't exist
  const opencodeConfig = path.join(groupDir, 'opencode.json');
  if (!fs.existsSync(opencodeConfig)) {
    fs.writeFileSync(
      opencodeConfig,
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          instructions: ['./AGENTS.md'],
          tools: {
            bash: { permission: 'allow' },
            read: { permission: 'allow' },
            write: { permission: 'allow' },
            edit: { permission: 'allow' },
            glob: { permission: 'allow' },
            grep: { permission: 'allow' },
          },
        },
        null,
        2,
      ),
    );
  }

  return groupDir;
}

/** List all existing group folders. */
export function listGroupFolders(): string[] {
  try {
    return fs
      .readdirSync(GROUPS_DIR)
      .filter((name) => {
        const fullPath = path.join(GROUPS_DIR, name);
        return fs.statSync(fullPath).isDirectory() && isValidGroupFolder(name);
      });
  } catch {
    return [];
  }
}

/** Get the absolute path for a group folder. */
export function getGroupPath(folderName: string): string {
  return path.join(GROUPS_DIR, folderName);
}
