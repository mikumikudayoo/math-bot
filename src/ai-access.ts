import { MessageFlags } from 'discord.js';
import type { loadConfig } from './config.js';
import { adminStore } from './admin/store.js';

export type AIAccessConfig = Pick<ReturnType<typeof loadConfig>, 'aiTesterUserIds'> & { adminDatabase?: string };
export const PRIVATE_AI_MESSAGE = 'AI features are currently available only to private testers.';

export function isAITester(userId: string, config: AIAccessConfig): boolean {
  // Deliberately independent of guild permissions, ownership and coach status.
  if (config.aiTesterUserIds.includes(userId)) return true;
  try { return Boolean(config.adminDatabase && adminStore(config.adminDatabase).has(userId)); }
  catch { return false; } // Store unavailable: dynamic access fails closed.
}

export async function authorizeAIInteraction(
  interaction: { user: { id: string }; reply(options: { content: string; flags: typeof MessageFlags.Ephemeral }): Promise<unknown> },
  config: AIAccessConfig,
): Promise<boolean> {
  if (isAITester(interaction.user.id, config)) return true;
  await interaction.reply({ content: PRIVATE_AI_MESSAGE, flags: MessageFlags.Ephemeral });
  return false;
}
