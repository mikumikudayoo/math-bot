import { ChannelType,MessageFlags,PermissionFlagsBits,SlashCommandBuilder,type SlashCommandSubcommandBuilder } from 'discord.js';
import type { Command } from './types.js';
import { loadConfig } from '../config.js';
import { reminderStore } from '../reminders/scheduler.js';
import { parseTime,templates,type ReminderInput,type Template,type Recurrence } from '../reminders/types.js';
import type { ReminderStore } from '../reminders/store.js';

function fields(s:SlashCommandSubcommandBuilder,required:boolean){
  return s.addStringOption(o=>o.setName('template').setDescription('Reminder category').setRequired(required).addChoices(...templates.map(value=>({name:value,value}))))
    .addChannelOption(o=>o.setName('channel').setDescription('Destination server text channel').addChannelTypes(ChannelType.GuildText).setRequired(required))
    .addStringOption(o=>o.setName('at').setDescription('Send time: YYYY-MM-DD HH:mm, Asia/Manila, 24-hour').setRequired(required))
    .addStringOption(o=>o.setName('details').setDescription('Exact moderator-written text, including any event/deadline details').setMaxLength(1200).setRequired(required))
    .addRoleOption(o=>o.setName('role').setDescription('Only this role may be pinged'))
    .addStringOption(o=>o.setName('repeat').setDescription('Recurrence (default none)').addChoices({name:'none',value:'none'},{name:'days',value:'days'},{name:'months',value:'months'}))
    .addIntegerOption(o=>o.setName('interval').setDescription('Every N days/months (default 1)').setMinValue(1).setMaxValue(120));
}
export function makeReminderCommand(getStore:()=>ReminderStore=()=>reminderStore(loadConfig().reminderDatabase)):Command {
  return {
    data:new SlashCommandBuilder().setName('reminder').setDescription('Manage deterministic server reminders.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand(s=>fields(s.setName('create').setDescription('Create a scheduled reminder.'),true))
      .addSubcommand(s=>s.setName('list').setDescription('List the first 50 reminders, including delivery state.'))
      .addSubcommand(s=>s.setName('view').setDescription('View a reminder.').addStringOption(o=>o.setName('id').setDescription('Reminder ID').setRequired(true)))
      .addSubcommand(s=>fields(s.setName('edit').setDescription('Edit a pending reminder; reset recurrence anchor.').addStringOption(o=>o.setName('id').setDescription('Reminder ID').setRequired(true)),false).addBooleanOption(o=>o.setName('clear-role').setDescription('Remove the configured role mention')))
      .addSubcommand(s=>s.setName('cancel').setDescription('Cancel a pending reminder.').addStringOption(o=>o.setName('id').setDescription('Reminder ID').setRequired(true))),
    async execute(i){
      if(!i.inGuild()||!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){
        await i.reply({content:'manage server permission is required.',flags:MessageFlags.Ephemeral});return;
      }
      await i.deferReply({flags:MessageFlags.Ephemeral});
      const reply=(content:string)=>i.editReply({content,allowedMentions:{parse:[]}});
      try{
        const store=getStore(),guild=i.guildId!,action=i.options.getSubcommand();
        if(action==='list'){
          const rows=store.list(guild);
          const text=rows.map(r=>`${r.id} · ${r.template} · ${r.state} · <t:${Math.floor(r.due/1000)}:R>`).join('\n');
          if(text.length>1900)await i.editReply({content:'reminders (first 50):',files:[{attachment:Buffer.from(text),name:'reminders.txt'}],allowedMentions:{parse:[]}});
          else await reply(text||'no reminders yet.');return;
        }
        const id=i.options.getString('id');const old=id?store.get(guild,id):undefined;
        if(action!=='create'&&!old)throw new Error('Reminder not found in this server.');
        if(action==='view'){
          await reply(`${old!.id} · ${old!.state}\n${old!.template} · channel <#${old!.channel}> · role ${old!.role??'none'}\n<t:${Math.floor(old!.due/1000)}:F> · <t:${Math.floor(old!.due/1000)}:R>\nrepeat: ${old!.recurrence}, interval ${old!.interval}\n${old!.details}\nlast message: ${old!.message??'none'}\ncreator: ${old!.creator} · editor: ${old!.editor}`);return;
        }
        if(action==='cancel'){store.cancel(guild,id!,i.user.id);await reply('reminder cancelled.');return;}
        const at=i.options.getString('at');
        const input:ReminderInput={guild,channel:i.options.getChannel('channel')?.id??old?.channel??'',role:i.options.getBoolean('clear-role')?null:i.options.getRole('role')?.id??old?.role??null,
          template:(i.options.getString('template')??old?.template) as Template,details:i.options.getString('details')??old?.details??'',due:at?parseTime(at):old?.due??0,
          recurrence:(i.options.getString('repeat')??old?.recurrence??'none') as Recurrence,interval:i.options.getInteger('interval')??old?.interval??1};
        const channel=await i.guild!.channels.fetch(input.channel);
        if(!channel||channel.type!==ChannelType.GuildText)throw new Error('Choose a text channel in this server.');
        const member=await i.guild!.members.fetch(i.user.id);const bot=await i.guild!.members.fetchMe();
        if(!channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages])||!channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error('You and the bot must be able to view and send in the destination.');
        if(input.role){const role=await i.guild!.roles.fetch(input.role);if(!role||role.id===guild)throw new Error('Choose an existing role, not everyone.');if(!role.mentionable&&!channel.permissionsFor(bot)?.has(PermissionFlagsBits.MentionEveryone))throw new Error('The bot cannot mention that role; make it mentionable or choose another.');}
        if(action==='create'){const r=store.create(input,i.user.id);await reply(`reminder created: ${r.id}\n<t:${Math.floor(r.due/1000)}:F>`);}
        else{store.edit(guild,id!,input,i.user.id);await reply(`reminder updated: ${id}`);}
      }catch(error){await reply(error instanceof Error?error.message:'Reminder operation failed.');}
    },
  };
}
export const reminder=makeReminderCommand();
