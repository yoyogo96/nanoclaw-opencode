/**
 * Filesystem-based IPC for inter-group communication and task management.
 * Containers write JSON files to their IPC namespace; the host polls and processes them.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { isValidGroupFolder } from './group-folder.js';
import * as db from './db.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registerGroup: (name: string, folder: string) => void;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  syncGroups: () => Promise<void>;
  writeGroupSnapshot: (folder: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) return;
  ipcWatcherRunning = true;

  const ipcBase = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBase, { recursive: true });

  logger.info('IPC watcher started (per-group namespaces)');
  poll(deps, ipcBase);
}

async function poll(deps: IpcDeps, ipcBase: string): Promise<void> {
  try {
    await processIpcFiles(deps, ipcBase);
  } catch (err) {
    logger.error({ err }, 'Error in IPC poll cycle');
  }
  setTimeout(() => poll(deps, ipcBase), IPC_POLL_INTERVAL);
}

async function processIpcFiles(
  deps: IpcDeps,
  ipcBase: string,
): Promise<void> {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(ipcBase).filter((name) => {
      const full = path.join(ipcBase, name);
      return fs.statSync(full).isDirectory();
    });
  } catch {
    return;
  }

  const groups = deps.getRegisteredGroups();

  for (const dir of dirs) {
    const dirPath = path.join(ipcBase, dir);
    const isMain = Object.values(groups).some(
      (g) => g.folder === dir && g.isMain,
    );

    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        if (file.startsWith('send-')) {
          await processMessageIpc(deps, data, dir, isMain);
        } else if (file.startsWith('task-')) {
          await processTaskIpc(deps, data, dir, isMain);
        }

        fs.unlinkSync(filePath);
      } catch (err) {
        logger.warn({ err, file: filePath }, 'Failed to process IPC file');
        // Move to errors directory
        const errDir = path.join(DATA_DIR, 'ipc', 'errors');
        fs.mkdirSync(errDir, { recursive: true });
        try {
          fs.renameSync(
            filePath,
            path.join(errDir, `${dir}-${file}`),
          );
        } catch {
          fs.unlinkSync(filePath);
        }
      }
    }
  }
}

async function processMessageIpc(
  deps: IpcDeps,
  data: { jid?: string; text?: string },
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  if (!data.jid || !data.text) {
    logger.warn({ sourceGroup }, 'IPC message missing jid or text');
    return;
  }
  await deps.sendMessage(data.jid, data.text);
}

async function processTaskIpc(
  deps: IpcDeps,
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  const operation = data.operation as string;

  switch (operation) {
    case 'schedule_task': {
      const taskData = data as {
        chat_jid: string;
        prompt: string;
        schedule_type: 'cron' | 'interval' | 'once';
        schedule_value: string;
        group_folder?: string;
        context_mode?: 'group' | 'isolated';
      };

      // Non-main groups can only schedule for themselves
      const targetFolder = isMain
        ? taskData.group_folder ?? sourceGroup
        : sourceGroup;

      if (!isMain && taskData.group_folder && taskData.group_folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, target: taskData.group_folder },
          'Non-main group attempted cross-group task scheduling',
        );
        return;
      }

      const nextRun = computeNextRun(
        taskData.schedule_type,
        taskData.schedule_value,
      );

      const task: ScheduledTask = {
        id: crypto.randomUUID(),
        group_folder: targetFolder,
        chat_jid: taskData.chat_jid,
        prompt: taskData.prompt,
        schedule_type: taskData.schedule_type,
        schedule_value: taskData.schedule_value,
        context_mode: taskData.context_mode ?? 'group',
        next_run: nextRun,
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: new Date().toISOString(),
      };

      db.createTask(task);
      logger.info({ taskId: task.id, folder: targetFolder }, 'Scheduled new task');
      break;
    }

    case 'pause_task': {
      const taskId = data.task_id as string;
      const task = db.getTask(taskId);
      if (!task) return;
      if (!isMain && task.group_folder !== sourceGroup) return;
      db.updateTask(taskId, { status: 'paused' });
      break;
    }

    case 'resume_task': {
      const taskId = data.task_id as string;
      const task = db.getTask(taskId);
      if (!task) return;
      if (!isMain && task.group_folder !== sourceGroup) return;
      const nextRun = computeNextRun(task.schedule_type, task.schedule_value);
      db.updateTask(taskId, { status: 'active', next_run: nextRun });
      break;
    }

    case 'cancel_task': {
      const taskId = data.task_id as string;
      const task = db.getTask(taskId);
      if (!task) return;
      if (!isMain && task.group_folder !== sourceGroup) return;
      db.deleteTask(taskId);
      break;
    }

    case 'update_task': {
      const taskId = data.task_id as string;
      const task = db.getTask(taskId);
      if (!task) return;
      if (!isMain && task.group_folder !== sourceGroup) return;
      const updates: Partial<ScheduledTask> = {};
      if (data.prompt) updates.prompt = data.prompt as string;
      if (data.schedule_value) {
        updates.schedule_value = data.schedule_value as string;
        updates.next_run = computeNextRun(
          task.schedule_type,
          data.schedule_value as string,
        );
      }
      db.updateTask(taskId, updates);
      break;
    }

    case 'refresh_groups': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Non-main group attempted refresh_groups');
        return;
      }
      await deps.syncGroups();
      break;
    }

    case 'register_group': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Non-main group attempted register_group');
        return;
      }
      const folderName = data.folder as string;
      if (!isValidGroupFolder(folderName)) {
        logger.warn({ folder: folderName }, 'Invalid folder name in register_group');
        return;
      }
      deps.registerGroup(data.name as string, folderName);
      break;
    }

    default:
      logger.warn({ operation, sourceGroup }, 'Unknown IPC task operation');
  }
}

function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
): string | null {
  const now = new Date();

  switch (scheduleType) {
    case 'cron': {
      try {
        const interval = CronExpressionParser.parse(scheduleValue, {
          currentDate: now,
          tz: TIMEZONE,
        });
        return interval.next().toISOString();
      } catch (err) {
        logger.warn({ err, expression: scheduleValue }, 'Invalid cron expression');
        return null;
      }
    }

    case 'interval': {
      const ms = Number(scheduleValue);
      if (isNaN(ms) || ms <= 0) return null;
      return new Date(now.getTime() + ms).toISOString();
    }

    case 'once': {
      const target = new Date(scheduleValue);
      if (isNaN(target.getTime())) return null;
      return target > now ? target.toISOString() : null;
    }

    default:
      return null;
  }
}

export { computeNextRun };
