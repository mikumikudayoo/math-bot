import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { DiscordAPIError, REST, Routes } from 'discord.js';
import { loadConfig } from '../config.js';
import { commandJSON } from '../commands/index.js';

let stage = 'loading configuration';
async function main() {
  const config = loadConfig();
  if(config.mode==='production'&&!process.argv.includes('--confirm-production'))throw new Error('Production registration requires --confirm-production.');
  const json = commandJSON();
  const path = `.cache/commands-${config.applicationId}-${config.guildId??'global'}.json`;
  let previous: string | undefined;
  try { previous = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous === json) { console.log('Definitions unchanged; no deployment needed.'); return; }
  const rest = new REST({ version: '10' }).setToken(config.token);
  stage = 'checking the token application';
  const app = await rest.get(Routes.oauth2CurrentApplication()) as { id: string };
  if (app.id !== config.applicationId) throw new Error('Token/application ID mismatch.');
  stage = config.guildId?'registering commands in the test server':'registering production global commands';
  await rest.put(config.guildId?Routes.applicationGuildCommands(config.applicationId, config.guildId):Routes.applicationCommands(config.applicationId), { body: JSON.parse(json) });
  stage = 'saving the successful deployment snapshot (Discord registration succeeded)';
  await mkdir('.cache', { recursive: true });
  await writeFile(`${path}.tmp`, json);
  await rename(`${path}.tmp`, path);
  console.log(config.guildId?'Development guild commands registered.':'Production global commands registered.');
}
main().catch(error => {
  console.error(`Registration failed while ${stage}.`);
  // Never dump REST errors: they can contain request details and credentials.
  if (error instanceof DiscordAPIError) {
    console.error(`Discord HTTP ${error.status}, code ${error.code}.`);
    if (error.code === 50001) console.error('Missing Access: check DISCORD_GUILD_ID and install this dev application into that server with bot and applications.commands scopes.');
    else if (error.code === 50013) console.error('Missing Permissions: check the dev application installation and server permissions.');
    else if (error.code === 10004) console.error('Unknown Guild: DISCORD_GUILD_ID must be the test server ID, not a channel or application ID.');
  } else if (stage === 'loading configuration' && error instanceof Error) {
    console.error(error.message);
  } else if (error instanceof Error && error.message === 'Token/application ID mismatch.') {
    console.error(error.message);
  } else {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[A-Z_0-9]+$/.test(code)) console.error(`Error code: ${code}`);
    else console.error('Check network connectivity and local filesystem access.');
  }
  process.exitCode = 1;
});
