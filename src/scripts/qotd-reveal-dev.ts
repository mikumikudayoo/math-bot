import {
  Client,
  GatewayIntentBits,
} from 'discord.js';

import {
  qotdStore,
  revealAnswer,
} from '../qotd/posting.js';

import { loadConfig } from '../config.js';

const id = Number(process.argv[2]);

if (!Number.isInteger(id) || id < 1) {
  console.error('Usage: bun run qotd:reveal-dev <post-id>');
  process.exit(1);
}

const config = loadConfig();

if (config.mode !== 'development') {
  console.error('Refusing to run outside development mode.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  try {
    const store = qotdStore();
    const guild = config.guildId;

    if (!guild) {
      throw new Error('Development guild is not configured.');
    }

    const entry = store.historyEntry(guild, id);

    if (!entry) {
      throw new Error(`Unknown MPoTD post id ${id}.`);
    }

    const channel = await client.channels.fetch(
      String(entry.channel),
    );

    if (
      !channel ||
      !('guildId' in channel) ||
      channel.guildId !== guild ||
      !channel.isSendable()
    ) {
      throw new Error(
        'Original MPoTD channel is unavailable.',
      );
    }

    const result = await revealAnswer(
      store,
      guild,
      id,
      client.user!.id,
      payload => channel.send(payload),
      Date.now(),
    );

    console.log(`✓ ${result}`);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.stack ?? error.message
        : error,
    );

    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

await client.login(config.token);
