export async function collectReactors(fetchPage:(after?:string)=>Promise<{id:string;bot:boolean}[]>) {
  const users=new Set<string>();let after:string|undefined;
  while(true){
    const page=await fetchPage(after);
    for(const user of page)if(!user.bot)users.add(user.id);
    if(page.length<100)return users;
    const last=page.at(-1)?.id;if(!last||last===after)throw new Error('Could not paginate reactions.');after=last;
  }
}
