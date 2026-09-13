import { PermissionFlagsBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { submit } from '../study.js';
import { service } from '../ai-client.js';
import type { Command } from './types.js';

export const ask:Command={
  access:'ai-tester',
  data:new SlashCommandBuilder().setName('ask').setDescription('Ask a study question.').addStringOption(o=>o.setName('question').setDescription('Your question').setRequired(true).setMaxLength(4000))
    .addAttachmentOption(o=>o.setName('image').setDescription('Optional PNG or JPEG for a vision-capable backend')),
  async execute(i){const image=i.options.getAttachment('image');await submit(i,'ask',i.options.getString('question',true),image?.url);},
};
export const calculate:Command={
  access:'ai-tester',
  data:new SlashCommandBuilder().setName('calculate').setDescription('Calculate or use symbolic math without an AI model.')
    .addStringOption(o=>o.setName('expression').setDescription('Example: (2+3)^2, sin(pi/2), x^2-4').setRequired(true).setMaxLength(500))
    .addStringOption(o=>o.setName('operation').setDescription('Operation in x; solve means expression = 0').addChoices(...['simplify','differentiate','integrate','solve'].map(x=>({name:x,value:x})))),
  async execute(i){await submit(i,'calculate',JSON.stringify({expression:i.options.getString('expression',true),operation:i.options.getString('operation')??'simplify'}));},
};
export const plot:Command={
  access:'ai-tester',
  data:new SlashCommandBuilder().setName('plot').setDescription('Plot an expression in x.')
    .addStringOption(o=>o.setName('expression').setDescription('Example: sin(x)').setRequired(true).setMaxLength(500))
    .addNumberOption(o=>o.setName('min').setDescription('Start x, default -10').setMinValue(-10000).setMaxValue(10000))
    .addNumberOption(o=>o.setName('max').setDescription('End x, default 10').setMinValue(-10000).setMaxValue(10000)),
  async execute(i){await submit(i,'plot',JSON.stringify({expression:i.options.getString('expression',true),min:i.options.getNumber('min')??-10,max:i.options.getNumber('max')??10}));},
};
export const python:Command={
  access:'ai-tester',
  data:new SlashCommandBuilder().setName('python').setDescription('Run Python in the optional isolated sandbox.').addStringOption(o=>o.setName('code').setDescription('Python code; no network or host files').setRequired(true).setMaxLength(4000)),
  async execute(i){await submit(i,'python',i.options.getString('code',true));},
};
export const cancel:Command={
  access:'ai-tester',
  data:new SlashCommandBuilder().setName('cancel').setDescription('Cancel one of your accepted requests.').addStringOption(o=>o.setName('request').setDescription('Request ID shown in the queued message').setRequired(true)),
  async execute(i){await i.deferReply({flags:MessageFlags.Ephemeral});await service('/cancel',{id:i.options.getString('request',true),guild:i.guildId,user:i.user.id});await i.editReply('Request cancelled (if it was still queued or running).');},
};
export const queue:Command={
  access:'ai-tester',
  data:new SlashCommandBuilder().setName('queue').setDescription('Show your accepted requests and their IDs.'),
  async execute(i){await i.deferReply({flags:MessageFlags.Ephemeral});const jobs=await service<{id:string;state:string;status:string}[]>(`/queue?guild=${i.guildId}&user=${i.user.id}`);await i.editReply(jobs.map(j=>`${j.id}: ${j.state} (${j.status})`).join('\n')||'You have no queued or active requests.');},
};
export const ai:Command={
  access:'ai-tester',
  data:new SlashCommandBuilder().setName('ai').setDescription('Manage study assistance.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(o=>o.setName('enable').setDescription('Accept new study requests.'))
    .addSubcommand(o=>o.setName('disable').setDescription('Reject future requests; accepted requests still finish.'))
    .addSubcommand(o=>o.setName('status').setDescription('Show availability.')),
  async execute(i){
    if(!i.inGuild()||!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)){await i.reply({content:'Manage Server permission is required.',flags:MessageFlags.Ephemeral});return;}
    await i.deferReply({flags:MessageFlags.Ephemeral});const action=i.options.getSubcommand();
    if(action==='status'){
      const [settings,health]=await Promise.all([service<{enabled:boolean}>(`/settings?guild=${i.guildId}`),service<{modelConfigured:boolean}>('/health')]);
      await i.editReply(`Assistance: ${settings.enabled?'enabled':'disabled'}\nAI backend: ${health.modelConfigured?'configured':'not configured'}`);
    }else{await service('/settings',{guild:i.guildId,user:i.user.id,moderator:true,enabled:action==='enable'});await i.editReply(action==='enable'?'New study requests are enabled.':'New study requests are disabled. Active and accepted queued requests will still finish.');}
  },
};
