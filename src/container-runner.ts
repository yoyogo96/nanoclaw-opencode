/**
 * Container runner — spawns OpenCode agents in isolated Docker containers.
 *
 * Key difference from the CC-based version: instead of running `claude` inside
 * the container, we run `opencode run` with the prompt passed as arguments.
 * OpenCode reads AGENTS.md for per-group instructions (replacing CLAUDE.md).
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  IDLE_TIMEOUT,
  PROJECT_ROOT,
  GROUPS_DIR,
  DATA_DIR,
  OPENCODE_MODEL,
} from './config.js';
import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  writableMountArgs,
} from './container-runtime.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { AgentResult, RegisteredGroup, AdditionalMount } from './types.js';

const OUTPUT_START = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END = '---NANOCLAW_OUTPUT_END---';

interface RunContainerOpts {
  groupFolder: string;
  groupName: string;
  prompt: string;
  sessionId?: string;
  group: RegisteredGroup;
  onOutput?: (text: string) => void;
  onActivity?: () => void;
}

/**
 * Build the volume mount arguments for a container.
 */
function buildVolumeMounts(
  groupFolder: string,
  group: RegisteredGroup,
): string[] {
  const args: string[] = [];
  const absGroupDir = path.join(GROUPS_DIR, groupFolder);
  const absDataDir = path.join(DATA_DIR, 'ipc', groupFolder);

  // Project root — read-only
  args.push(...readonlyMountArgs(PROJECT_ROOT, '/app'));

  // Group folder — writable (agent's working directory)
  fs.mkdirSync(absGroupDir, { recursive: true });
  args.push(...writableMountArgs(absGroupDir, '/work'));

  // Per-group IPC namespace — writable
  fs.mkdirSync(absDataDir, { recursive: true });
  args.push(...writableMountArgs(absDataDir, '/data/ipc'));

  // Per-group OpenCode config directory
  const opencodeDir = path.join(absGroupDir, '.opencode');
  fs.mkdirSync(opencodeDir, { recursive: true });
  args.push(...writableMountArgs(opencodeDir, '/work/.opencode'));

  // Shadow .env with /dev/null to prevent secret leakage
  args.push('-v', '/dev/null:/app/.env:ro');

  // Additional mounts from group config
  if (group.containerConfig?.additionalMounts) {
    for (const mount of group.containerConfig.additionalMounts) {
      const containerPath =
        mount.containerPath ?? `/mnt/${path.basename(mount.hostPath)}`;
      if (mount.readonly) {
        args.push(...readonlyMountArgs(mount.hostPath, containerPath));
      } else {
        args.push(...writableMountArgs(mount.hostPath, containerPath));
      }
    }
  }

  return args;
}

/**
 * Build the full `docker run` argument list.
 */
function buildContainerArgs(
  containerName: string,
  groupFolder: string,
  group: RegisteredGroup,
  prompt: string,
  sessionId?: string,
): string[] {
  const volumeArgs = buildVolumeMounts(groupFolder, group);
  const timeout = group.containerConfig?.timeout ?? CONTAINER_TIMEOUT;

  const args: string[] = [
    'run',
    '--rm',
    '--name',
    containerName,
    '-i',
    '--workdir',
    '/work',
    // Environment variables for OpenCode
    '-e',
    `OPENCODE_MODEL=${OPENCODE_MODEL}`,
    '-e',
    'OPENCODE_CONFIG_CONTENT={"tools":{"bash":{"permission":"allow"},"read":{"permission":"allow"},"write":{"permission":"allow"},"edit":{"permission":"allow"},"glob":{"permission":"allow"},"grep":{"permission":"allow"}}}',
    '-e',
    `NANOCLAW_GROUP=${groupFolder}`,
    '-e',
    `NANOCLAW_TIMEOUT=${timeout}`,
    ...volumeArgs,
    CONTAINER_IMAGE,
    // OpenCode non-interactive run command
    'opencode',
    'run',
    '--format',
    'json',
  ];

  // Append session resume if available
  if (sessionId) {
    args.push('--attach', sessionId);
  }

  // The prompt is passed as the final argument
  args.push(prompt);

  return args;
}

/**
 * Spawn a container running an OpenCode agent and stream its output.
 */
export function runContainerAgent(opts: RunContainerOpts): {
  process: ChildProcess;
  result: Promise<AgentResult>;
} {
  const {
    groupFolder,
    groupName,
    prompt,
    sessionId,
    group,
    onOutput,
    onActivity,
  } = opts;

  const containerName = `nanoclaw-${groupFolder}-${crypto.randomBytes(4).toString('hex')}`;

  // Read secrets from .env to pass via stdin (never mounted as files)
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
  ]);

  const args = buildContainerArgs(
    containerName,
    groupFolder,
    group,
    prompt,
    sessionId,
  );

  // Inject API keys as env vars
  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(secrets)) {
    // Insert env args before the image name
    envArgs.push('-e', `${key}=${value}`);
  }

  // Insert env args before the CONTAINER_IMAGE argument
  const imageIdx = args.indexOf(CONTAINER_IMAGE);
  args.splice(imageIdx, 0, ...envArgs);

  logger.info(
    { container: containerName, group: groupName, folder: groupFolder },
    'Spawning OpenCode agent container',
  );

  const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let outputBuffer = '';
  let totalSize = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let containerTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.warn({ container: containerName }, 'Container idle timeout reached');
      proc.kill('SIGTERM');
    }, IDLE_TIMEOUT);
    onActivity?.();
  };

  // Hard timeout
  const timeout = group.containerConfig?.timeout ?? CONTAINER_TIMEOUT;
  containerTimer = setTimeout(() => {
    logger.warn({ container: containerName }, 'Container hard timeout reached');
    proc.kill('SIGTERM');
  }, timeout);

  const result = new Promise<AgentResult>((resolve, reject) => {
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      totalSize += text.length;

      if (totalSize > CONTAINER_MAX_OUTPUT_SIZE) {
        logger.error({ container: containerName }, 'Container output exceeded max size');
        proc.kill('SIGTERM');
        return;
      }

      outputBuffer += text;
      resetIdle();

      // Extract output between sentinel markers
      let startIdx: number;
      while ((startIdx = outputBuffer.indexOf(OUTPUT_START)) !== -1) {
        const endIdx = outputBuffer.indexOf(OUTPUT_END, startIdx);
        if (endIdx === -1) break;

        const content = outputBuffer.slice(
          startIdx + OUTPUT_START.length,
          endIdx,
        ).trim();

        outputBuffer =
          outputBuffer.slice(0, startIdx) +
          outputBuffer.slice(endIdx + OUTPUT_END.length);

        if (content) {
          onOutput?.(content);
        }
      }

      // Also handle JSON streaming from `opencode run --format json`
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event.type === 'text' && event.content) {
            onOutput?.(event.content);
          } else if (event.type === 'assistant' && event.text) {
            onOutput?.(event.text);
          }
        } catch {
          // Not JSON — may be raw text output
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      logger.debug({ container: containerName, stderr: text }, 'Container stderr');
      resetIdle();
    });

    proc.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (containerTimer) clearTimeout(containerTimer);

      const finalOutput = outputBuffer.trim();
      logger.info(
        { container: containerName, exitCode: code },
        'Container exited',
      );

      resolve({
        output: finalOutput,
        exitCode: code ?? 1,
      });
    });

    proc.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      if (containerTimer) clearTimeout(containerTimer);
      logger.error({ err, container: containerName }, 'Container process error');
      reject(err);
    });
  });

  return { process: proc, result };
}

/**
 * Write a task snapshot file for the container to pick up.
 */
export function writeTaskSnapshot(
  groupFolder: string,
  data: Record<string, unknown>,
): void {
  const snapshotDir = path.join(DATA_DIR, 'snapshots', groupFolder);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, 'task.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(data, null, 2));
}
