export interface RoleAdapter {
  reactors():Promise<Set<string>>;
  owned():Promise<Set<string>>;
  member(user:string):Promise<{hasRole:boolean;bot:boolean}|null>;
  mark(user:string,owned:boolean):Promise<void>;
  add(user:string):Promise<void>;
  remove(user:string):Promise<void>;
}
export async function reconcileRoles(adapter:RoleAdapter) {
  // Read all pages successfully before considering any removals.
  const reactors=await adapter.reactors();const owned=await adapter.owned();
  const stats={added:0,removed:0,preserved:0,absent:0};
  for(const user of new Set([...reactors,...owned])){
    const member=await adapter.member(user);
    if(!member){if(owned.has(user))await adapter.mark(user,false);stats.absent++;continue;}
    if(member.bot)continue;
    if(reactors.has(user)){
      if(member.hasRole){stats.preserved++;continue;}
      // Durable intent before Discord write allows a successful add to survive a crash.
      await adapter.mark(user,true);
      await adapter.add(user);stats.added++;
    }else if(owned.has(user)){
      if(member.hasRole){await adapter.remove(user);stats.removed++;}
      await adapter.mark(user,false);
    }
  }
  return stats;
}
