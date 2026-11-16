import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {MessageFlags, type ChatInputCommandInteraction} from 'discord.js';
import {ai, showUsage} from '../src/commands/study.js';
import {MODERATOR_ROLE_ID} from '../src/admin/auth.js';
import {UsageLedger} from '../src/service/openai-budget.js';
import {parseOpenAIConfig} from '../src/service/openai-config.js';

function interaction(roles: string[], manageGuild: boolean) {
  const replies: unknown[] = [];
  const i = {
    user: {id:'100000000000000001'}, member: {roles}, memberPermissions:{has:() => manageGuild},
    guild:{roles:{fetch:async () => null}}, inGuild:() => true, options:{getSubcommand:() => 'usage'},
    reply:async (value:unknown) => { replies.push(value); }, deferReply:async (value:unknown) => { replies.push(value); },
    editReply:async (value:unknown) => { replies.push(value); },
  };
  return {i:i as unknown as ChatInputCommandInteraction, replies};
}

test('account-wide usage command is registered, private and guarded in unrelated guilds', async () => {
  assert.ok(ai.data.toJSON().options?.some(o => o.name === 'usage'));
  const guest = interaction([], false);
  await ai.execute(guest.i);
  assert.deepEqual(guest.replies,[{content:'Manage Server permission is required.',flags:MessageFlags.Ephemeral}]);
  const otherGuild = interaction([], true);
  await ai.execute(otherGuild.i);
  assert.deepEqual(otherGuild.replies,[{flags:MessageFlags.Ephemeral},'Only the bot’s database moderators can view account-wide estimates.']);
});

test('authorized moderator sees estimates and legacy state without altering provider settings', async () => {
  const {i,replies} = interaction([MODERATOR_ROLE_ID],false);
  await showUsage(i,async () => ({provider:'legacy'}));
  assert.equal(replies[0],'The OpenAI provider is disabled.');
  const db = new DatabaseSync(':memory:');
  try {
    const config = parseOpenAIConfig({AI_PROVIDER:'openai',OPENAI_API_KEY:'sk-test'+'x'.repeat(30)})!;
    const ledger = new UsageLedger(db, config);
    await showUsage(i, async () => ledger.summary());
    const entry = db.prepare("INSERT INTO openai_usage(job,user,day,created,model,effort,tier,status,cost_micros) VALUES('j','system',?,?,?,'low','system','ok',1)");
    const today = ledger.summary().day;
    for (let n=0;n<30;n++) entry.run(today,Date.now(),'historical-model-'+n);
    await showUsage(i, async () => ledger.summary());
  } finally { db.close(); }
  assert.match(String(replies[1]),/estimated/);
  assert.match(String(replies[1]),/\$0\.0000/);
  const long = replies[2] as {content:string;files:{name:string;attachment:Buffer}[]};
  assert.ok(long.content.length <= 2000);
  assert.equal(long.files[0]?.name,'usage.txt');
  assert.match(long.files[0]!.attachment.toString(),/historical-model-29/);
});
