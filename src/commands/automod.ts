import { AttachmentBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { loadConfig } from '../config.js';
import { securityStore } from '../security/runtime.js';
import { securityActor, canReadSecurity, authorizeConfigChange } from '../security/authorization.js';
import { validateSecurityConfig } from '../security/config.js';
import { decide } from '../security/detectors.js';

export const automod:Command={
  data:new SlashCommandBuilder().setName('automod').setDescription('Inspect and configure Aleph moderation.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(s=>s.setName('status').setDescription('Inspect mode, rules and configuration.'))
    .addSubcommand(s=>s.setName('test').setDescription('Preview findings without actions or infractions.').addStringOption(o=>o.setName('text').setDescription('Text to inspect').setRequired(true).setMaxLength(4000)).addStringOption(o=>o.setName('source').setDescription('Message or profile preview').addChoices({name:'message',value:'message'},{name:'profile',value:'profile'})).addUserOption(o=>o.setName('user').setDescription('Optional real member to check role/user exemptions.')))
    .addSubcommand(s=>s.setName('configure').setDescription('Owner/security-admin: replace validated server config.').addStringOption(o=>o.setName('json').setDescription('Complete security configuration JSON').setRequired(true).setMaxLength(6000)).addBooleanOption(o=>o.setName('confirm').setDescription('Confirm the replacement').setRequired(true)))
    .addSubcommand(s=>s.setName('cases').setDescription('Inspect recent moderation cases.').addIntegerOption(o=>o.setName('case').setDescription('Case ID with action outcomes').setMinValue(1)).addUserOption(o=>o.setName('user').setDescription('Filter recent cases for a member.'))),
  async execute(i){
    await i.deferReply({flags:MessageFlags.Ephemeral});
    try{
      const env=loadConfig(),actor=await securityActor(i),store=securityStore(env.moderationDatabase),current=store.config(i.guildId!);
      if(!canReadSecurity(actor,current.config)){await i.editReply('Manage Messages or security-admin authorization is required.');return;}
      const action=i.options.getSubcommand();
      if(action==='status'){
        await i.editReply({content:`Aleph moderation: ${current.config.mode}\nGlobal engine: ${env.moderationEngine?'enabled':'disabled'}\nConfiguration revision: ${current.revision}\nEnabled rules: ${current.config.rules.filter(r=>r.enabled).length}\nPolicies: ${current.config.policies.map(p=>p.id).join(', ')}\nDiscord AutoMod remains separately configured.`,files:[new AttachmentBuilder(Buffer.from(JSON.stringify(current.config,null,2)),{name:'security-config.json'})],allowedMentions:{parse:[]}});
      }else if(action==='configure'){
        if(i.options.getBoolean('confirm',true)!==true)throw new Error('Set confirm:true to replace configuration.');
        const next=validateSecurityConfig(JSON.parse(i.options.getString('json',true)));
        authorizeConfigChange(actor,current.config,next);
        if(next.logChannel){const channel=await i.guild!.channels.fetch(next.logChannel,{force:true});if(!channel||channel.guildId!==i.guildId||!channel.isSendable())throw new Error('Log channel must be a sendable channel in this server.');}
        const revision=store.saveConfig(i.guildId!,next,actor.id,current.revision);
        await i.editReply(`Security configuration saved as revision ${revision}. Mode: ${next.mode}. ${env.moderationEngine?'':'The global engine is disabled.'}`);
      }else if(action==='test'){
        const source=i.options.getString('source')==='profile'?'profile':'message';
        const target=i.options.getUser('user'),member=target?await i.guild!.members.fetch({user:target.id,force:true}):null;
        const channel=i.channel;const parent=channel?.isThread()&&channel.parentId?await i.guild!.channels.fetch(channel.parentId,{force:true}):null;
        const input={guild:i.guildId!,eventId:'preview',source,content:i.options.getString('text',true),author:{id:member?.id??'preview',bot:member?.user.bot??false,staff:Boolean(member&&(member.permissions.has(PermissionFlagsBits.ManageMessages)||member.id===i.guild!.ownerId))},roles:member?[...member.roles.cache.keys()]:[],channel:{id:i.channelId,parent:channel?.isThread()?channel.parentId:null,category:parent?.parentId??(channel&&'parentId' in channel&&!channel.isThread()?channel.parentId:null)},timestamp:Date.now()} as const;
        const findings=current.detect(input),decision=decide(current.config,findings,()=>0,source);
        await i.editReply({content:`Preview only. ${findings.length} finding(s). First-violation action: ${decision.action}; delete: ${decision.delete}. ${member?'Selected member and channel exemptions apply.':'Synthetic non-staff member; channel exemptions apply.'}`,files:[new AttachmentBuilder(Buffer.from(JSON.stringify({findings,decision},null,2)),{name:'automod-preview.json'})],allowedMentions:{parse:[]}});
      }else{
        const id=i.options.getInteger('case'),records=id?[store.get(i.guildId!,id)].filter(Boolean):store.recent(i.guildId!,i.options.getUser('user')?.id);
        await i.editReply({content:`${records.length} case(s). Records include findings and the saved policy decision; no original message body is retained.`,files:[new AttachmentBuilder(Buffer.from(JSON.stringify({cases:records,...(id?{events:store.events(i.guildId!,id)}:{})},null,2)),{name:'moderation-cases.json'})],allowedMentions:{parse:[]}});
      }
    }catch(error){await i.editReply({content:error instanceof Error?error.message.slice(0,1800):'Security command failed.',allowedMentions:{parse:[]}});}
  },
};
