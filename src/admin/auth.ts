import { PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { CREATOR_ID } from '../discord-context.js';

export const MODERATOR_ROLE_ID = '1419154303326621739';
export function isOwner(actor: { user: { id: string } }) { return actor.user?.id === CREATOR_ID; }
export function isModerator(i: Pick<ChatInputCommandInteraction, 'inGuild' | 'user' | 'member' | 'memberPermissions'>, stronger = PermissionFlagsBits.ManageGuild) {
  if (!i.inGuild()) return false;
  const roles = i.member?.roles;
  return isOwner(i) || Boolean(i.memberPermissions?.has(stronger)) ||
    (Array.isArray(roles) ? roles.includes(MODERATOR_ROLE_ID) : Boolean(roles?.cache.has(MODERATOR_ROLE_ID)));
}
export function discordId(id: string) {
  if (!/^\d{17,20}$/.test(id)) throw new Error('Invalid Discord user ID.');
  return id;
}
/** Raw SQL is database-wide: Manage Server in an unrelated guild is insufficient. */
export async function isDatabaseModerator(i: ChatInputCommandInteraction) {
  if (!isModerator(i)) return false;
  if (isOwner(i)) return true;
  const roles=i.member?.roles;
  if (Array.isArray(roles)?roles.includes(MODERATOR_ROLE_ID):roles?.cache.has(MODERATOR_ROLE_ID)) return true;
  try { return Boolean(await i.guild?.roles.fetch(MODERATOR_ROLE_ID)); } catch { return false; }
}
