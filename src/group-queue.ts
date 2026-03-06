/**
 * Per-group queue with concurrency control.
 * Ensures at most MAX_CONCURRENT_CONTAINERS containers run globally,
 * and at most one container per group at a time.
 */
import { MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';
import type { ChildProcess } from 'child_process';
import type { NewMessage, ScheduledTask, GroupState } from './types.js';

interface ProcessGroupFn {
  (
    groupFolder: string,
    messages: NewMessage[],
  ): Promise<void>;
}

interface RunTaskFn {
  (task: ScheduledTask): Promise<void>;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processGroup: ProcessGroupFn;
  private runTask: RunTaskFn;

  constructor(processGroup: ProcessGroupFn, runTask: RunTaskFn) {
    this.processGroup = processGroup;
    this.runTask = runTask;
  }

  private getState(folder: string): GroupState {
    if (!this.groups.has(folder)) {
      this.groups.set(folder, {
        active: false,
        isTaskContainer: false,
        pendingMessages: [],
        pendingTasks: [],
        running: null,
        retryCount: 0,
      });
    }
    return this.groups.get(folder)!;
  }

  /** Enqueue a message check for a group. */
  enqueueMessageCheck(
    groupFolder: string,
    chatJid: string,
    messages: NewMessage[],
  ): void {
    const state = this.getState(groupFolder);

    if (state.active) {
      // Group already running — queue messages for later
      state.pendingMessages.push({ chatJid, messages });
      logger.debug(
        { folder: groupFolder, pending: state.pendingMessages.length },
        'Queued messages for busy group',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages.push({ chatJid, messages });
      if (!this.waitingGroups.includes(groupFolder)) {
        this.waitingGroups.push(groupFolder);
      }
      logger.debug(
        { folder: groupFolder, active: this.activeCount },
        'At container limit, group queued',
      );
      return;
    }

    this.runForGroup(groupFolder, messages);
  }

  /** Enqueue a scheduled task. */
  enqueueTask(groupFolder: string, task: ScheduledTask): void {
    const state = this.getState(groupFolder);

    // Prevent duplicate task queueing
    if (state.pendingTasks.some((t) => t.id === task.id)) {
      return;
    }

    if (state.active) {
      state.pendingTasks.push(task);
      logger.debug(
        { folder: groupFolder, taskId: task.id },
        'Queued task for busy group',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push(task);
      if (!this.waitingGroups.includes(groupFolder)) {
        this.waitingGroups.push(groupFolder);
      }
      return;
    }

    this.executeTask(groupFolder, task);
  }

  /** Send a message to an active group's container via stdin. */
  sendMessage(groupFolder: string, text: string): boolean {
    const state = this.getState(groupFolder);
    if (!state.active || !state.running?.process || state.isTaskContainer) {
      return false;
    }
    try {
      state.running.process.stdin?.write(text + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Signal that a group container is idle. */
  notifyIdle(groupFolder: string): void {
    const state = this.getState(groupFolder);
    // If there are pending tasks, close stdin to end the current container
    if (state.pendingTasks.length > 0 && state.running?.process) {
      state.running.process.stdin?.end();
    }
  }

  /** Get the running process for a group. */
  getRunning(groupFolder: string): ChildProcess | null {
    return this.getState(groupFolder).running?.process ?? null;
  }

  /** Check if a group is actively running. */
  isActive(groupFolder: string): boolean {
    return this.getState(groupFolder).active;
  }

  private async runForGroup(
    groupFolder: string,
    messages: NewMessage[],
  ): Promise<void> {
    const state = this.getState(groupFolder);
    state.active = true;
    state.isTaskContainer = false;
    this.activeCount++;

    try {
      await this.processGroup(groupFolder, messages);
      state.retryCount = 0;
    } catch (err) {
      logger.error({ err, folder: groupFolder }, 'Error processing group');
      state.retryCount++;
      if (state.retryCount <= 5) {
        const delay = 5000 * Math.pow(2, state.retryCount - 1);
        setTimeout(() => {
          if (state.pendingMessages.length > 0) {
            const pending = state.pendingMessages.shift()!;
            this.runForGroup(groupFolder, pending.messages);
          }
        }, delay);
      }
    } finally {
      state.active = false;
      state.running = null;
      this.activeCount--;
      this.drainGroup(groupFolder);
      this.drainWaiting();
    }
  }

  private async executeTask(
    groupFolder: string,
    task: ScheduledTask,
  ): Promise<void> {
    const state = this.getState(groupFolder);
    state.active = true;
    state.isTaskContainer = true;
    this.activeCount++;

    try {
      await this.runTask(task);
    } catch (err) {
      logger.error({ err, folder: groupFolder, taskId: task.id }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.running = null;
      this.activeCount--;
      this.drainGroup(groupFolder);
      this.drainWaiting();
    }
  }

  /** Process pending work for a group — tasks take priority. */
  private drainGroup(groupFolder: string): void {
    const state = this.getState(groupFolder);
    if (state.active) return;

    // Tasks before messages
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.executeTask(groupFolder, task);
      return;
    }

    if (state.pendingMessages.length > 0) {
      const pending = state.pendingMessages.shift()!;
      this.runForGroup(groupFolder, pending.messages);
    }
  }

  /** Allocate freed container slots to waiting groups. */
  private drainWaiting(): void {
    while (
      this.activeCount < MAX_CONCURRENT_CONTAINERS &&
      this.waitingGroups.length > 0
    ) {
      const folder = this.waitingGroups.shift()!;
      this.drainGroup(folder);
    }
  }

  /** Graceful shutdown — detach containers so they can finish naturally. */
  async shutdown(): Promise<void> {
    logger.info('Shutting down group queue');
    for (const [folder, state] of this.groups) {
      if (state.running?.process) {
        logger.info({ folder }, 'Detaching container for graceful shutdown');
        state.running.process.unref();
      }
    }
  }
}
