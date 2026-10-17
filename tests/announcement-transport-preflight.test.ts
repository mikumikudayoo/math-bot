import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChannelType, type Client } from 'discord.js';
import { AnnouncementStore, type AnnouncementJob, type Payload } from '../src/announcements/store.js';
import { documentTemplates, type Extraction } from '../src/announcements/model.js';
import type { AutomationConfig } from '../src/announcements/config.js';
import { effectivePolicy, registerEffectivePolicy } from '../src/announcements/delivery-identity.js';
import { plan } from '../src/announcements/planner.js';
import { createAnnouncementTransport,deliverAnnouncements } from '../src/announcements/delivery.js';

const guild = '111111111111111111', channelId = '222222222222222222', roleId = '333333333333333333';
const baseConfig: AutomationConfig = {
  enabled: true, autoSend: false, database: ':memory:', assets: '/tmp/synthetic-announcement-transport-assets',
  policy: { guild, channel: channelId, role: roleId, staffChannel: null, policies: [{ id: 'synthetic-session-hour', type: 'training-session', anchor: 'start', beforeMinutes: 60, template: 'session', major: false, asset: 'none' }], templates: documentTemplates },
  gmail: { account: 'synthetic-test', query: 'from:organizer@example.org', senders: ['organizer@example.org'], clientId: '', clientSecret: '', refreshToken: '' },
  provider: { backend: 'https://api.groq.com/openai/v1', model: 'synthetic-test', backendKey: '', vision: false, nativeTools: false }, pollMs: 120000,
};
type AwaitPoint = 'channel' | 'member' | 'role';
interface TransportFixture {
  store: AnnouncementStore;
  runtime: AutomationConfig;
  job: AnnouncementJob;
  payload: Payload;
  permissions: { allowed: boolean };
  send: ReturnType<typeof createAnnouncementTransport>;
  messages: unknown[];
  awaited: AwaitPoint[];
  sendError?:boolean;
}

function fixture(point: AwaitPoint, mutate: (fixture: TransportFixture) => void): TransportFixture {
  const store = new AnnouncementStore(':memory:'), runtime = structuredClone(baseConfig), now = Date.now();
  // This injected test-only runtime never calls automationConfig or changes an
  // environment/config file. The ordinary fixture retains autoSend=false.
  runtime.autoSend = true;
  const input = JSON.parse(readFileSync(new URL('../docs/examples/announcements/vtamps-v25-0.json', import.meta.url), 'utf8')) as Extraction;
  input.source.account = 'synthetic-test'; input.source.messageId = 'synthetic-transport-source';
  input.events = [input.events[0]!];
  input.events[0]!.event.start = now + 3_600_000 - 5_000;
  input.events[0]!.event.end = input.events[0]!.event.start + 3_600_000;
  input.events[0]!.event.timezoneAssumed = false;
  const event = input.events[0]!.event;
  Object.assign(event, { temporal: { start: { precision: 'exact', expression: new Date(event.start!).toISOString(), sourceTime: null }, end: { precision: 'exact', expression: new Date(event.end!).toISOString(), sourceTime: null } } });
  Object.assign(input.events[0]!, { evidenceIds: ['body'] });
  store.saveEvidence(store.source(guild, input.source), { evidence: [{ id: 'body', text: `VTAMPS V.25.0 Senior Secondary Session 1: ${new Date(event.start!).toISOString()} to ${new Date(event.end!).toISOString()} Asia/Manila.` }], blocked: [] });
  store.ingest(guild, input, now);
  const candidate = store.candidates(guild)[0]!;
  store.approve(guild, candidate.id, candidate.review_version, 'synthetic-staff', now);
  const registered = registerEffectivePolicy(store, runtime.policy, 0);
  assert.equal(registered.accepted, true);
  plan(store, runtime.policy, now, registered.snapshot);
  const scheduled = store.jobs(guild).find(job => job.state === 'scheduled');
  assert.ok(scheduled, 'the synthetic reminder must be planned before transport');
  const claimed = store.claim(scheduled.id, now, registered.snapshot);
  assert.ok(claimed, 'the synthetic reminder must be durably reserved before transport');
  const messages: unknown[] = [], awaited: AwaitPoint[] = [], permissions = { allowed: true };
  let prepared: TransportFixture;
  const wait = async (at: AwaitPoint) => {
    await Promise.resolve();
    awaited.push(at);
    if (at === point) mutate(prepared);
  };
  const fakeChannel = {
    id: channelId, type: ChannelType.GuildText, guildId: guild,
    permissionsFor: () => ({ has: () => permissions.allowed }),
    guild: {
      members: { fetchMe: async () => { await wait('member'); return { id: '555555555555555555' }; } },
      roles: { fetch: async () => { await wait('role'); return { id: roleId, mentionable: true }; } },
    },
    send: async (message: unknown) => { messages.push(message); if(prepared.sendError)throw new Error('Synthetic timeout after send invocation.');return { id: '666666666666666666' }; },
  };
  const client = { channels: { fetch: async (id: string) => { assert.equal(id, channelId); await wait('channel'); return fakeChannel; } } } as unknown as Client;
  const send = createAnnouncementTransport(client, store, () => structuredClone(runtime));
  prepared = { store, runtime, job: claimed, payload: JSON.parse(claimed.payload_json) as Payload, permissions, send, messages, awaited };
  return prepared;
}

const denied: { label: string; mutate: (fixture: TransportFixture) => void }[] = [
  { label: 'auto-send is disabled', mutate: fixture => { fixture.runtime.autoSend = false; } },
  { label: 'a source hold arrives', mutate: fixture => {
    const source = fixture.store.source(guild, { account: 'synthetic-test', messageId: 'synthetic-unreadable-correction', attachment: null, sha256: 'a'.repeat(64), locator: 'synthetic replacement evidence pending' });
    fixture.store.holdSource(guild, source);
  } },
  { label: 'the approved event is cancelled', mutate: fixture => { fixture.store.cancel(guild, fixture.job.event_key, 'cancelled', 'synthetic-staff', fixture.job.revision); } },
  { label: 'the destination policy changes', mutate: fixture => { fixture.runtime.policy.channel = '777777777777777777'; } },
  { label: 'the persisted payload changes', mutate: fixture => {
    fixture.store.db.prepare('UPDATE announcement_jobs SET payload_json=? WHERE id=?').run(JSON.stringify({ ...fixture.payload, content: 'Unapproved synthetic announcement wording.' }), fixture.job.id);
  } },
  { label: 'the publication window expires', mutate: fixture => { fixture.store.db.prepare('UPDATE announcement_jobs SET expires=? WHERE id=?').run(Date.now() - 1_000, fixture.job.id); } },
  { label: 'the bot loses send permissions', mutate: fixture => { fixture.permissions.allowed = false; } },
];

test('known-unsent permission failures retry the same obligation once resolved, without duplicate active jobs',async()=>{
  const f=fixture('channel',()=>{}),{store,job}=f;try{
    assert.equal(store.preflightFailed(job),true);f.permissions.allowed=false;
    for(let attempt=0;attempt<3;attempt++){
      plan(store,f.runtime.policy,Date.now());await deliverAnnouncements(store,f.runtime,f.send);
      assert.equal(f.messages.length,0);assert.equal(store.job(guild,job.id)!.state,'scheduled');
      assert.equal(store.logicalDeliveryConsumed(job.logical_delivery_id!),false);
      assert.equal(store.db.prepare('SELECT count(*) n FROM logical_delivery_reservations').get()!.n,0);
      assert.equal(store.jobs(guild).filter(j=>['scheduled','delivering'].includes(j.state)).length,1);
    }
    assert.equal(store.db.prepare("SELECT count(*) n FROM audit_log WHERE action='delivery-preflight-failed'").get()!.n,4);
    f.permissions.allowed=true;await deliverAnnouncements(store,f.runtime,f.send);
    assert.equal(f.messages.length,1);assert.equal(store.job(guild,job.id)!.state,'sent');
    plan(store,f.runtime.policy,Date.now());await deliverAnnouncements(store,f.runtime,f.send);assert.equal(f.messages.length,1);
  }finally{store.close();}
});

test('post-send errors remain uncertain and consumed across planner ticks',async()=>{
  const f=fixture('channel',()=>{}),{store,job}=f;try{
    store.preflightFailed(job);f.sendError=true;await deliverAnnouncements(store,f.runtime,f.send);
    assert.equal(f.messages.length,1);assert.equal(store.job(guild,job.id)!.state,'uncertain');assert.equal(store.logicalDeliveryConsumed(job.logical_delivery_id!),true);
    assert.equal(store.preflightFailed(job),false);
    for(let tick=0;tick<3;tick++){plan(store,f.runtime.policy,Date.now());await deliverAnnouncements(store,f.runtime,f.send);}
    assert.equal(f.messages.length,1);
  }finally{store.close();}
});

test('a stale preflight callback cannot release or finish a newer reserved attempt',()=>{
  const f=fixture('channel',()=>{}),{store,job}=f;try{
    assert.equal(store.preflightFailed(job),true);const next=store.claim(job.id,Date.now(),effectivePolicy(store,guild))!;assert.ok(next);
    assert.notEqual(next.attempt_at,job.attempt_at);assert.equal(store.preflightFailed(job),false);store.finish(job,null);
    assert.equal(store.job(guild,job.id)!.state,'delivering');assert.equal(store.logicalDeliveryConsumed(job.logical_delivery_id!),true);
    assert.throws(()=>store.validateDelivery(job.id,effectivePolicy(store,guild)!,Date.now(),f.payload,job.attempt_at),/stale/);
  }finally{store.close();}
});

test('known-unsent retries recheck current policy and replace only the obsolete unsent generation',async()=>{
  const f=fixture('channel',()=>{}),{store,job}=f;try{
    store.preflightFailed(job);f.permissions.allowed=false;await deliverAnnouncements(store,f.runtime,f.send);
    f.runtime.policy.templates.session='Session {{slot}} at {{timeRange}}.';
    const snapshot=registerEffectivePolicy(store,f.runtime.policy,effectivePolicy(store,guild)!.revision).snapshot;
    plan(store,f.runtime.policy,Date.now(),snapshot);
    assert.equal(store.job(guild,job.id)!.state,'superseded');
    const active=store.jobs(guild).filter(j=>j.state==='scheduled');assert.equal(active.length,1);assert.equal(active[0]!.logical_delivery_id,job.logical_delivery_id);
    f.permissions.allowed=true;await deliverAnnouncements(store,f.runtime,f.send);assert.equal(f.messages.length,1);
  }finally{store.close();}
});

test('known-unsent obligations remain held or gated and expire without catch-up',async()=>{
  const f=fixture('channel',()=>{}),{store,job}=f;try{
    store.preflightFailed(job);f.runtime.autoSend=false;await deliverAnnouncements(store,f.runtime,f.send);assert.equal(f.messages.length,0);
    f.runtime.autoSend=true;const source=store.source(guild,{account:'synthetic',messageId:'temporary-source-barrier',attachment:null,sha256:'e'.repeat(64),locator:'body'});
    await deliverAnnouncements(store,f.runtime,f.send);assert.equal(f.messages.length,0);assert.equal(store.job(guild,job.id)!.state,'held');
    store.dismissSource(guild,source,'staff');
    plan(store,f.runtime.policy,job.expires+1);await deliverAnnouncements(store,f.runtime,f.send,job.expires+1);
    assert.equal(f.messages.length,0);assert.equal(store.job(guild,job.id)!.state,'skipped');
  }finally{store.close();}
});

for (const point of ['channel', 'member', 'role'] as const) {
  for (const scenario of denied) test(`transport rechecks ${scenario.label} after asynchronous ${point} fetch`, async () => {
    const fixtureValue = fixture(point, scenario.mutate), { store, job } = fixtureValue;
    try {
      const reservation = store.db.prepare('SELECT * FROM logical_delivery_reservations WHERE job=?').get(job.id);
      assert.ok(reservation);
      await assert.rejects(() => fixtureValue.send(job, fixtureValue.payload));
      assert.equal(fixtureValue.messages.length, 0, 'the fake Discord channel must receive no announcement');
      assert.ok(fixtureValue.awaited.includes(point), 'the mutation must occur across the selected await');
      assert.deepEqual(store.db.prepare('SELECT * FROM logical_delivery_reservations WHERE job=?').get(job.id), reservation);
      assert.equal(store.claim(job.id, Date.now(), effectivePolicy(store, guild)), undefined, 'preflight denial must not revive the reservation');
      // Explicit reconciliation may close a known-unsent reservation, but its
      // consumed logical identity must still survive later planner runs.
      store.reconcile(guild, job.id, null, 'synthetic-staff');
      const current = effectivePolicy(store, guild)!;
      const registered = registerEffectivePolicy(store, fixtureValue.runtime.policy, current.revision);
      assert.equal(registered.accepted, true);
      plan(store, fixtureValue.runtime.policy, Date.now(), registered.snapshot);
      const sameObligation = store.db.prepare('SELECT state FROM announcement_jobs WHERE logical_delivery_id=?').all(job.logical_delivery_id!);
      assert.ok(sameObligation.length > 0);
      assert.ok(sameObligation.every(row => !['scheduled', 'pending_approval'].includes(String(row.state))), 'a consumed delivery must not be replanned after preflight denial');
      assert.equal(baseConfig.autoSend, false);
    } finally { store.close(); }
  });

  test(`an unrelated staff channel edit during ${point} fetch preserves the valid reserved announcement`, async () => {
    const fixtureValue = fixture(point, value => { value.runtime.policy.staffChannel = '888888888888888888'; }), { store, job } = fixtureValue;
    try {
      const result = await fixtureValue.send(job, fixtureValue.payload);
      assert.equal(fixtureValue.messages.length, 1);
      assert.ok(fixtureValue.awaited.includes(point));
      store.finish(job, result.id);
      assert.equal(store.job(guild, job.id)?.state, 'sent');
      const snapshot = effectivePolicy(store, guild)!;
      assert.equal(snapshot.policy.staffChannel, '888888888888888888');
      plan(store, fixtureValue.runtime.policy, Date.now(), snapshot);
      const sameObligation = store.db.prepare('SELECT state FROM announcement_jobs WHERE logical_delivery_id=?').all(job.logical_delivery_id!);
      assert.equal(sameObligation.length, 1);
      assert.equal(sameObligation[0]?.state, 'sent');
      assert.equal(store.claim(job.id, Date.now(), snapshot), undefined);
      assert.equal(baseConfig.autoSend, false);
    } finally { store.close(); }
  });
}
