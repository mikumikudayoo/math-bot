import {AttachmentBuilder,type Client} from 'discord.js';
import {canDisclose} from './discord-tools.js';
import {rowProvenance} from './service/provenance.js';
import type {Job} from './service/types.js';

interface DeliveryPayload {content:string;files:AttachmentBuilder[];allowedMentions:{parse:[]};attachments?:[];embeds?:[]}
// An earlier edit may have succeeded before its delivery acknowledgement failed.
// On a denied retry, explicitly remove retained files/embeds as well as text.
const refusal=():DeliveryPayload=>({content:"i can't safely share that server history here. ask in the channel the messages came from.",files:[],attachments:[],embeds:[],allowedMentions:{parse:[]}});

/** Content is the host-sanitized studyContent(job), never raw model text.
 * Recheck every source immediately before returning text or attachments to edit.
 */
export async function studyDeliveryPayload(client:Client,job:Job,content:string):Promise<DeliveryPayload>{
  const terminal=['completed','failed','cancelled'].includes(job.state);
  const provenance=rowProvenance(job);
  if(terminal&&provenance.classification==='private-discord'){
    if(provenance.audienceUnknown||!provenance.discordSources.length||provenance.discordSources.some(source=>source.guildId!==job.guild))return refusal();
    try{
      const guild=await client.guilds.fetch({guild:job.guild,force:true});
      if(guild.id!==job.guild)return refusal();
      await guild.roles.fetch();
      const [requester,bot]=await Promise.all([
        guild.members.fetch({user:job.user,force:true,cache:false}),
        guild.members.fetchMe({force:true,cache:false}),
      ]);
      const destination=await guild.channels.fetch(job.channel,{force:true});
      if(!destination||destination.guildId!==job.guild||!destination.isTextBased()||!destination.isSendable())return refusal();
      for(const id of new Set(provenance.discordSources.map(source=>source.channelId))){
        const source=await guild.channels.fetch(id,{force:true});
        if(!source||!await canDisclose(source,destination,requester,bot))return refusal();
      }
    }catch{return refusal();}
  }
  const files:AttachmentBuilder[]=[];
  if(terminal&&content.length>1900)files.push(new AttachmentBuilder(Buffer.from(content),{name:'answer.txt'}));
  if(terminal&&job.artifact)files.push(new AttachmentBuilder(Buffer.from(job.artifact,'base64'),{name:'plot.png'}));
  return {content:content.slice(0,1900)+(terminal&&content.length>1900?'\n\nfull answer attached.':''),files,allowedMentions:{parse:[]}};
}
