import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRoles, type RoleAdapter } from '../src/reaction-role-core.js';
import { collectReactors } from '../src/reaction-pagination.js';

function fixture(reacted:string[],hasRole:string[],tracked:string[]=[]){
  const reactors=new Set(reacted),roles=new Set(hasRole),owned=new Set(tracked),absent=new Set<string>();
  const calls:string[]=[];
  const adapter:RoleAdapter={async reactors(){return reactors;},async owned(){return new Set(owned);},async member(u){return absent.has(u)?null:{hasRole:roles.has(u),bot:u==='bot'};},
    async mark(u,on){on?owned.add(u):owned.delete(u);},async add(u){roles.add(u);calls.push(`add ${u}`);},async remove(u){roles.delete(u);calls.push(`remove ${u}`);}};
  return {adapter,reactors,roles,owned,absent,calls};
}
test('existing reaction + existing role is preserved and never claimed',async()=>{
  const f=fixture(['a'],['a']);await reconcileRoles(f.adapter);assert.deepEqual(f.calls,[]);assert.equal(f.owned.size,0);
  f.reactors.clear();await reconcileRoles(f.adapter);assert.ok(f.roles.has('a'));
});
test('old reactor missing role gets one assignment; duplicate events are harmless',async()=>{
  const f=fixture(['a'],[]);await reconcileRoles(f.adapter);await reconcileRoles(f.adapter);
  assert.deepEqual(f.calls,['add a']);assert.ok(f.owned.has('a'));
  f.reactors.clear();await reconcileRoles(f.adapter);await reconcileRoles(f.adapter);assert.deepEqual(f.calls,['add a','remove a']);
});
test('manual role without reaction remains; bot-owned stale role is removed after restart',async()=>{
  const f=fixture([],['manual','owned'],['owned']);await reconcileRoles(f.adapter);assert.deepEqual([...f.roles],['manual']);
});
test('cleared reactions, departed members and bots are handled',async()=>{
  const f=fixture(['bot'],['a'],['a','left']);f.absent.add('left');await reconcileRoles(f.adapter);
  assert.equal(f.owned.size,0);assert.deepEqual(f.calls,['remove a']);assert.ok(!f.roles.has('bot'));
});
test('failed reaction pagination never removes roles',async()=>{
  const f=fixture([],['a'],['a']);f.adapter.reactors=async()=>{throw new Error('permission denied');};
  await assert.rejects(reconcileRoles(f.adapter));assert.ok(f.roles.has('a'));assert.deepEqual(f.calls,[]);
});
test('failed removal keeps ownership for a retry',async()=>{
  const f=fixture([],['a'],['a']);f.adapter.remove=async()=>{throw new Error('permission denied');};
  await assert.rejects(reconcileRoles(f.adapter));assert.ok(f.owned.has('a'));
});
test('interrupted grant is reconciled; missing bot-owned role is restored while reacted',async()=>{
  const f=fixture(['a'],[],['a']);await reconcileRoles(f.adapter);assert.deepEqual(f.calls,['add a']);
});
test('reaction pagination covers more than 100 users and skips bots',async()=>{
  const all=Array.from({length:205},(_,i)=>({id:String(i+1),bot:i===0}));let pages=0;
  const users=await collectReactors(async after=>{pages++;const offset=after?Number(after):0;return all.slice(offset,offset+100);});
  assert.equal(users.size,204);assert.equal(pages,3);assert.ok(users.has('205'));assert.ok(!users.has('1'));
});
