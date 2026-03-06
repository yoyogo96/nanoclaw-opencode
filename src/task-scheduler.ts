/**
 * Task scheduler — polls for due tasks and executes them via container agents.
 */
import path from 'path';
import { SCHEDULER_POLL_INTERVAL, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { runContainerAgent, writeTaskSnapshot } from './container-runner.js';
import { computeNextRun } from './ipc.js';
import * as db from './db.js';
import type { GroupQueue } from './group-queue.js';
import type { RegisteredGroup, ScheduledTask, Channel } from './types.js';
import { formatOutbound, routeOutbound } from './router.js';

export interface SchedulerDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Map<string, string>;
  queue: GroupQueue;
  channels: Channel[];
  sendMessage: (jid: string, text: string) => Promise<void>;
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDeps): void {
  if (schedulerRunning) return;
  schedulerRunning = true;
  logger.info('Task scheduler started');
  pollTasks(deps);
}

async function pollTasks(deps: SchedulerDeps): Promise<void> {
  try {
    const dueTasks = db.getDueTasks();

    for (const task of dueTasks) {
      // Re-validate task status (may have been paused between poll and execution)
      const current = db.getTask(task.id);
      if (!current || current.status !== 'active') continue;

      deps.queue.enqueueTask(task.group_folder, task);
    }
  } catch (err) {
    logger.error({ err }, 'Error in scheduler poll cycle');
  }
  setTimeout(() => pollTasks(deps), SCHEDULER_POLL_INTERVAL);
}

export async function runScheduledTask(
  task: ScheduledTask,
  deps: SchedulerDeps,
): Promise<void> {
  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );
  if (!group) {
    logger.warn({ taskId: task.id, folder: task.group_folder }, 'No group found for task');
    return;
  }

  const groupDir = path.resolve(GROUPS_DIR, task.group_folder);
  const startTime = Date.now();

  // Write task snapshot for the container
  writeTaskSnapshot(task.group_folder, {
    taskId: task.id,
    prompt: task.prompt,
    chatJid: task.chat_jid,
    groupFolder: task.group_folder,
  });

  logger.info(
    { taskId: task.id, folder: task.group_folder, prompt: task.prompt },
    'Executing scheduled task',
  );

  let result = '';

  try {
    const { process: proc, result: resultPromise } = runContainerAgent({
      groupFolder: task.group_folder,
      groupName: group.name,
      prompt: task.prompt,
      sessionId: deps.getSessions().get(task.group_folder),
      group,
      onOutput: (text) => {
        result += text;
      },
    });

    const agentResult = await resultPromise;
    result = result || agentResult.output;

    const duration = Date.now() - startTime;

    // Log the task run
    db.logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: duration,
      status: 'success',
      result: result.slice(0, 10_000),
      error: null,
    });

    // Update task — compute next run or mark completed
    const nextRun = computeNextRun(task.schedule_type, task.schedule_value);
    if (nextRun) {
      db.updateTask(task.id, {
        last_run: new Date().toISOString(),
        last_result: result.slice(0, 10_000),
        next_run: nextRun,
      });
    } else {
      db.updateTask(task.id, {
        last_run: new Date().toISOString(),
        last_result: result.slice(0, 10_000),
        status: 'completed',
        next_run: null,
      });
    }

    // Send result to the chat if there's output
    const outbound = formatOutbound(result);
    if (outbound) {
      await deps.sendMessage(task.chat_jid, outbound);
    }

    logger.info(
      { taskId: task.id, duration, hasOutput: !!outbound },
      'Scheduled task completed',
    );
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    db.logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: duration,
      status: 'error',
      result: null,
      error: errorMsg,
    });

    logger.error(
      { err, taskId: task.id, folder: task.group_folder },
      'Scheduled task failed',
    );
  }
}
