#!/usr/bin/env node

/**
 * spawn-from-env.mjs — driver-managed "spawn from env" entrypoint.
 *
 * Replaces the SDK's removed `spawnFromEnv()` helper (dropped in
 * @agent-relay/sdk 8.x). Runs as PID 1 inside a spawned OpenClaw container:
 * it starts a broker joined to the workspace, launches the bridge as a PTY
 * child that inherits the broker's env, and stays alive until the broker exits.
 *
 * Reads from the environment (set by DockerSpawnProvider):
 *   RELAY_WORKSPACE_KEY / RELAY_API_KEY  workspace key the broker joins
 *   RELAY_BASE_URL                       optional Agent Relay base URL
 *   AGENT_NAME                           spawned agent / broker name
 *   AGENT_CLI                            CLI to launch (default: node)
 *   AGENT_ARGS                           CLI args (whitespace-separated)
 *   AGENT_TASK                           initial task prompt
 *   AGENT_CHANNELS                       comma-separated channels
 *   AGENT_CWD                            working directory
 */

import { HarnessDriverClient } from '@agent-relay/harness-driver';

function splitArgs(value) {
  return (value ?? '')
    .split(/\s+/)
    .map((a) => a.trim())
    .filter(Boolean);
}

function splitChannels(value) {
  const channels = (value ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return channels.length ? channels : ['general'];
}

async function main() {
  const workspaceKey = process.env.RELAY_WORKSPACE_KEY ?? process.env.RELAY_API_KEY;
  if (!workspaceKey) {
    throw new Error('RELAY_WORKSPACE_KEY (or RELAY_API_KEY) is required to spawn an agent');
  }

  const name = process.env.AGENT_NAME;
  if (!name) {
    throw new Error('AGENT_NAME is required');
  }

  const cli = process.env.AGENT_CLI || 'node';
  const args = splitArgs(process.env.AGENT_ARGS);
  const channels = splitChannels(process.env.AGENT_CHANNELS);
  const task = process.env.AGENT_TASK || undefined;
  const cwd = process.env.AGENT_CWD || process.cwd();

  // Mirror the workspace key onto both env names the broker/MCP may read.
  process.env.RELAY_WORKSPACE_KEY = workspaceKey;
  process.env.RELAY_API_KEY = workspaceKey;

  const relay = await HarnessDriverClient.spawn({
    brokerName: name,
    workspaceKey,
    channels,
    cwd,
    env: process.env,
  });

  // Single-shot exit guard: overlapping signals or a broker-exit racing a
  // signal-triggered shutdown must not call process.exit twice.
  let exiting = false;
  const exit = (code) => {
    if (exiting) return;
    exiting = true;
    process.exit(code);
  };

  // Register the broker-exit handler BEFORE spawning so an early broker crash
  // is observed — this script runs as PID 1, so a missed exit hangs the container.
  relay.onBrokerExit((info) => {
    exit(typeof info?.code === 'number' ? info.code : 0);
  });

  const shutdown = async () => {
    if (exiting) return;
    await relay.shutdown().catch(() => {});
    exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // If the agent fails to spawn, tear the broker down instead of leaking it.
  try {
    await relay.spawnPty({ name, cli, args, channels, task, cwd });
  } catch (error) {
    await relay.shutdown().catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
