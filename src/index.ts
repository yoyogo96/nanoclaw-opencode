/**
 * NanoClaw — Personal AI assistant powered by OpenCode.
 *
 * Single Node.js process orchestrating:
 *   Channels → SQLite → Polling loop → Container (OpenCode agent) → Response
 *
 * This is the OpenCode-based rewrite. Key differences from the CC version:
 *   - Containers run `opencode run` instead of `claude`
 *   - Per-group instructions use AGENTS.md instead of CLAUDE.md
 *   - Supports 75+ LLM providers via OpenCode's model routing
 *   - Uses @opencode-ai/sdk for programmatic session management
 */
import fs from 'fs';
import path from 'path';
import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
  PROJECT_ROOT,
  GROUPS_DIR,
  DATA_DIR,
  STORE_DIR,
} from './config.js';
import { logger } from './logger.js';
import { initDb } from './db.js';
import * as db from './db.js';
import { getRegisteredChannelNames, type ChannelOpts } from './channels/index.js';
import {
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { runContainerAgent } from './container-runner.js';
import { formatMessages, formatOutbound, routeOutbound } from './router.js';
import { GroupQueue } from './group-queue.js';
import { ensureGroupFolder } from './group-folder.js';
import { isSenderAllowed } from './sender-allowlist.js';
import { startIpcWatcher } from './ipc.js';
import { startSchedulerLoop, runScheduledTask } from './task-scheduler.js';
import type {
  Channel,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';

// ── State ──────────────────────────────────────────────────

let lastTimestamp: string = new Date(0).toISOString();
const sessions = new Map<string, string>();
let registeredGroups: Record<string, RegisteredGroup> = {};
const lastAgentTimestamp = new Map<string, string>();
let messageLoopRunning = false;
const channels: Channel[] = [];

// ── Queue ──────────────────────────────────────────────────

const queue = new GroupQueue(processGroupMessages, runTask);

// ── State persistence ──────────────────────────────────────

function loadState(): void {
  const savedTimestamp = db.getRouterState('lastTimestamp');
  if (savedTimestamp) lastTimestamp = savedTimestamp;

  registeredGroups = db.getRegisteredGroups();

  // Restore sessions
  for (const [jid, group] of Object.entries(registeredGroups)) {
    const sessionId = db.getSession(group.folder);
    if (sessionId) sessions.set(group.folder, sessionId);
  }

  logger.info(
    {
      groups: Object.keys(registeredGroups).length,
      sessions: sessions.size,
    },
    'State loaded',
  );
}

function saveState(): void {
  db.setRouterState('lastTimestamp', lastTimestamp);
  for (const [folder, sessionId] of sessions) {
    db.setSession(folder, sessionId);
  }
}

// ── Group management ───────────────────────────────────────

function registerGroup(name: string, folder: string): void {
  ensureGroupFolder(folder);
  const group: RegisteredGroup = {
    name,
    folder,
    trigger: ASSISTANT_NAME,
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    isMain: Object.keys(registeredGroups).length === 0,
  };
  // Use a placeholder JID for manual registration
  const jid = `manual-${folder}`;
  db.registerGroup(jid, group);
  registeredGroups[jid] = group;
  logger.info({ name, folder, isMain: group.isMain }, 'Group registered');
}

function getAvailableGroups(): Array<{
  jid: string;
  name: string;
  folder: string;
}> {
  return Object.entries(registeredGroups)
    .sort(([, a], [, b]) => b.added_at.localeCompare(a.added_at))
    .map(([jid, g]) => ({ jid, name: g.name, folder: g.folder }));
}

// ── Message processing ─────────────────────────────────────

async function processGroupMessages(
  groupFolder: string,
  messages: NewMessage[],
): Promise<void> {
  const group = Object.values(registeredGroups).find(
    (g) => g.folder === groupFolder,
  );
  if (!group) {
    logger.warn({ folder: groupFolder }, 'No registered group for folder');
    return;
  }

  const chatJid = messages[0]?.chat_jid;
  if (!chatJid) return;

  // Format messages as XML prompt
  const formattedMessages = formatMessages(messages);
  const prompt = `New messages in the group:\n${formattedMessages}\n\nRespond to the above messages.`;

  logger.info(
    { folder: groupFolder, messageCount: messages.length },
    'Processing group messages via OpenCode',
  );

  // Set typing indicator if supported
  const channel = channels.find(
    (ch) => ch.isConnected() && ch.ownsJid(chatJid),
  );
  if (channel?.setTyping) {
    await channel.setTyping(chatJid, true).catch(() => {});
  }

  let responseText = '';

  try {
    const { process: proc, result } = runContainerAgent({
      groupFolder,
      groupName: group.name,
      prompt,
      sessionId: sessions.get(groupFolder),
      group,
      onOutput: (text) => {
        responseText += text;
      },
      onActivity: () => {
        // Reset idle detection
      },
    });

    const agentResult = await result;
    responseText = responseText || agentResult.output;

    // Update session if available
    if (agentResult.sessionId) {
      sessions.set(groupFolder, agentResult.sessionId);
    }

    // Send response
    const outbound = formatOutbound(responseText);
    if (outbound) {
      await routeOutbound(channels, chatJid, outbound);
    }

    // Update cursor
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      lastAgentTimestamp.set(chatJid, lastMsg.timestamp);
    }

    saveState();
  } catch (err) {
    logger.error({ err, folder: groupFolder }, 'Error in agent processing');
  } finally {
    if (channel?.setTyping) {
      await channel.setTyping(chatJid, false).catch(() => {});
    }
  }
}

async function runTask(task: ScheduledTask): Promise<void> {
  await runScheduledTask(task, {
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    channels,
    sendMessage: async (jid, text) => routeOutbound(channels, jid, text),
  });
}

// ── Message loop ───────────────────────────────────────────

function startMessageLoop(): void {
  if (messageLoopRunning) return;
  messageLoopRunning = true;
  logger.info('Message loop started');
  pollMessages();
}

async function pollMessages(): Promise<void> {
  try {
    // Get new messages from all chats since last timestamp
    for (const [jid, group] of Object.entries(registeredGroups)) {
      const cursor =
        lastAgentTimestamp.get(jid) ??
        lastTimestamp;

      const messages = db.getMessagesSince(jid, cursor);
      if (messages.length === 0) continue;

      // Filter messages
      const relevant = messages.filter((msg) => {
        // Skip our own messages
        if (msg.is_from_me || msg.is_bot_message) return false;

        // Check sender allowlist
        if (!isSenderAllowed(msg.sender)) return false;

        // Check trigger pattern if required
        if (group.requiresTrigger) {
          return TRIGGER_PATTERN.test(msg.content);
        }

        return true;
      });

      if (relevant.length > 0) {
        // Deduplicate by group folder
        queue.enqueueMessageCheck(group.folder, jid, relevant);
      }
    }

    // Update global timestamp
    lastTimestamp = new Date().toISOString();
    saveState();
  } catch (err) {
    logger.error({ err }, 'Error in message poll cycle');
  }

  setTimeout(pollMessages, POLL_INTERVAL);
}

// ── Channel callbacks ──────────────────────────────────────

function onInboundMessage(chatJid: string, message: NewMessage): void {
  db.storeMessage(message);
}

function onChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  db.upsertChat(chatJid, timestamp, name, channel, isGroup);
}

// ── Initialization ─────────────────────────────────────────

async function connectChannels(): Promise<void> {
  const channelNames = getRegisteredChannelNames();
  logger.info({ channels: channelNames }, 'Connecting channels');

  const opts: ChannelOpts = {
    onMessage: onInboundMessage,
    onChatMetadata: onChatMetadata,
    registeredGroups: () => registeredGroups,
  };

  // Dynamically import and connect each registered channel
  for (const name of channelNames) {
    try {
      const { getChannelFactory } = await import('./channels/index.js');
      const factory = getChannelFactory(name);
      if (!factory) continue;

      const channel = factory(opts);
      if (!channel) {
        logger.debug({ channel: name }, 'Channel skipped (no credentials)');
        continue;
      }

      await channel.connect();
      channels.push(channel);
      logger.info({ channel: name }, 'Channel connected');
    } catch (err) {
      logger.error({ err, channel: name }, 'Failed to connect channel');
    }
  }

  logger.info(
    { connected: channels.length, total: channelNames.length },
    'Channels initialized',
  );
}

async function main(): Promise<void> {
  logger.info(
    {
      name: ASSISTANT_NAME,
      version: '2.0.0',
      engine: 'OpenCode',
    },
    'NanoClaw starting',
  );

  // Ensure directories exist
  for (const dir of [GROUPS_DIR, DATA_DIR, STORE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Initialize database
  initDb();

  // Load persisted state
  loadState();

  // Ensure main group exists
  if (Object.keys(registeredGroups).length === 0) {
    registerGroup('main', 'main');
  }

  // Verify container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // Connect messaging channels
  await connectChannels();

  // Start subsystems
  startIpcWatcher({
    sendMessage: async (jid, text) => routeOutbound(channels, jid, text),
    registerGroup,
    getRegisteredGroups: () => registeredGroups,
    syncGroups: async () => {
      for (const ch of channels) {
        if (ch.syncGroups) await ch.syncGroups(true);
      }
    },
    writeGroupSnapshot: () => {},
  });

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    channels,
    sendMessage: async (jid, text) => routeOutbound(channels, jid, text),
  });

  // Start message loop
  startMessageLoop();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    saveState();

    for (const ch of channels) {
      try {
        await ch.disconnect();
      } catch (err) {
        logger.error({ err, channel: ch.name }, 'Error disconnecting channel');
      }
    }

    await queue.shutdown();
    logger.info('NanoClaw stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info(
    `NanoClaw is running — assistant "${ASSISTANT_NAME}" ready (powered by OpenCode)`,
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
