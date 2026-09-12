import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { commandJSON, loadCommands } from '../src/commands/index.js';
import ping from '../src/commands/ping.js';

const env = { DISCORD_TOKEN: 'test-only', DISCORD_APPLICATION_ID: '123456789012345678', DISCORD_GUILD_ID: '234567890123456789' };
test('dev requires a test guild; production does not inherit it', () => {
  assert.throws(() => parseConfig({ ...env, DISCORD_GUILD_ID: '' }, 'development'));
  assert.equal(parseConfig(env, 'production').guildId, undefined);
  assert.throws(() => parseConfig(env, 'staging'));
  assert.throws(() => parseConfig({ ...env, DISCORD_TOKEN: '' }, 'development'));
});
test('registry rejects duplicates and produces deployable ping definition', () => {
  assert.throws(() => loadCommands([ping, ping]), /Duplicate/);
  assert.ok(JSON.parse(commandJSON()).some((x:{name:string})=>x.name === 'ping'));
  assert.equal(commandJSON(), commandJSON());
});
