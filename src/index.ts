import { startQotd } from './qotd/posting.js';
import { Client, Events, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { loadCommands } from './commands/index.js';
import { ServiceError } from './ai-client.js';
import { startDelivery, handleStudyMessage } from './study.js';
import { moderate } from './moderation.js';
import { startReactionRoles } from './reaction-roles.js';

async function main() {
  const config = loadConfig();
  const commands = loadCommands();
  const client = new Client({ intents: [GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessageReactions,...(config.messageFeatures?[GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]:[])],
    partials:[Partials.Message,Partials.Channel,Partials.Reaction],allowedMentions: { parse: [] } });
  let stopDelivery=()=>{};let stopRoles=()=>{};let stopQotd=()=>{};
  client.once(Events.ClientReady, ready => {
    if (ready.application.id !== config.applicationId) {
      console.error('Token belongs to a different application. Check the selected environment file.');
      client.destroy();
      process.exitCode = 1;
      return;
    }
    console.log(`Logged in as ${ready.user.tag} (${config.mode}).`);
    stopDelivery=startDelivery(client);stopRoles=startReactionRoles(client);stopQotd=startQotd(client,config.guildId);
  });
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    try {
      if (config.guildId && interaction.guildId !== config.guildId) {
        await interaction.reply({ content: 'This dev bot only runs in its test server.', flags: MessageFlags.Ephemeral });
        return;
      }
      const command = commands.get(interaction.commandName);
      if (!command) {
        await interaction.reply({ content: 'That command is no longer available.', flags: MessageFlags.Ephemeral });
        return;
      }
      await command.execute(interaction);
    } catch (error) {
      console.error(`Command /${interaction.commandName} failed.`);
      const content=error instanceof ServiceError?error.message:'Something went wrong. Please try again.';
      try {
        if (interaction.deferred) await interaction.editReply({content});
        else if(interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      } catch { console.error('Could not deliver the command error response.'); }
    }
  });
  if(config.messageFeatures)client.on(Events.MessageCreate,async message=>{
    if(message.author.bot||!message.guildId||(config.guildId&&message.guildId!==config.guildId))return;
    try{if(await moderate(message))return;}catch{console.error('Moderation service unavailable.');}
    try{await handleStudyMessage(message);}catch(error){if(error instanceof ServiceError)await message.reply({content:error.message,allowedMentions:{parse:[],repliedUser:false}}).catch(()=>{});}
  });
  if(config.messageFeatures)client.on(Events.MessageUpdate,async(_old,message)=>{
    if(!message.guildId||(config.guildId&&message.guildId!==config.guildId))return;
    try{const full=message.partial?await message.fetch():message;await moderate(full);}catch{console.error('Could not moderate edited message.');}
  });
  client.on(Events.Error, () => console.error('Discord connection error.'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopDelivery();stopRoles();stopQotd();client.destroy(); });
  try { await client.login(config.token); }
  catch { client.destroy(); throw new Error('Discord login failed. Check the bot token and network connection.'); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Startup failed.'); process.exitCode = 1; });
