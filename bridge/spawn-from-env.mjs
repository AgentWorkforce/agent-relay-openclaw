#!/usr/bin/env node

import { spawnFromEnv } from '@agent-relay/sdk';

async function main() {
  if (!process.env.RELAY_API_KEY && process.env.RELAY_WORKSPACE_KEY) {
    process.env.RELAY_API_KEY = process.env.RELAY_WORKSPACE_KEY;
  }

  await spawnFromEnv();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
