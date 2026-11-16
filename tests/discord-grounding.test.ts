import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundedDiscordAnswer } from '../src/service/discord-grounding.js';

const guild = '111456789012345678';
const requester = '222456789012345678';
const creator = '333456789012345678';
const channel = '444456789012345678';
const message = '555456789012345678';

const results = [{
  id: message,
  channelId: channel,
  author: { id: requester },
  content: 'daily qotd is coming back at 8am, with a proper leaderboard'
}];

test('multiple passages preserve attribution and reject any unsupported claim',()=>{
  const other={...results[0]!,id:'666456789012345678',author:{id:creator},content:'the schedule has changed to 9am'};
  const claims=[{messageId:message,support:'qotd is coming back at 8am'},{messageId:other.id,support:other.content}];
  const answer=groundedDiscordAnswer({claims},[...results,other],guild,requester,creator);
  assert.match(answer!,/you said/);assert.match(answer!,/emu said/);assert.match(answer!,/9am/);
  assert.equal(groundedDiscordAnswer({claims:[...claims,{messageId:message,support:'invented schedule'}]},results,guild,requester,creator),null);
  assert.equal(groundedDiscordAnswer({claims:[{claims}]},results,guild,requester,creator),null);
});

test('quoted markdown and mentions cannot add fake links or ping users',()=>{
  const content='@everyone [click](https://example.com) **hello**';
  const answer=groundedDiscordAnswer({messageId:message,support:content},[{...results[0]!,content}],guild,requester,creator)!;
  assert.ok(!answer.includes('@everyone'));assert.ok(!answer.includes('[click]('));
});

test('Discord answer uses verified author, channel and message URL', () => {
  const answer = groundedDiscordAnswer(
    { messageId: message, support: 'qotd is coming back at 8am' },
    results, guild, requester, creator
  );

  assert.ok(answer?.startsWith('you said'));
  assert.ok(answer?.includes(`<#${channel}>`));
  assert.ok(answer?.includes(
    `https://discord.com/channels/${guild}/${channel}/${message}`
  ));
});

test('Discord answer rejects invented source text', () => {
  assert.equal(
    groundedDiscordAnswer(
      { messageId: message, support: 'qotd has been cancelled forever' },
      results, guild, requester, creator
    ),
    null
  );
});

test('Discord answer rejects invented message IDs', () => {
  assert.equal(
    groundedDiscordAnswer(
      {
        messageId: '666456789012345678',
        support: 'qotd is coming back at 8am'
      },
      results, guild, requester, creator
    ),
    null
  );
});
