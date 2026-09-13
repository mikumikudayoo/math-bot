import { MessageFlags } from 'discord.js';
import type { loadConfig } from './config.js';

export type AIAccessConfig = Pick<ReturnType<typeof loadConfig>, 'aiTesterUserIds'>;
export const PRIVATE_AI_MESSAGE = 'AI features are currently available only to private testers.';

export function isAITester(userId: string, config: AIAccessConfig): boolean {
  // Deliberately independent of guild permissions, ownership and coach status.
  return config.aiTesterUserIds.includes(userId);
}

export async function authorizeAIInteraction(
  interaction: { user: { id: string }; reply(options: { content: string; flags: typeof MessageFlags.Ephemeral }): Promise<unknown> },
  config: AIAccessConfig,
): Promise<boolean> {
  if (isAITester(interaction.user.id, config)) return true;
  await interaction.reply({ content: PRIVATE_AI_MESSAGE, flags: MessageFlags.Ephemeral });
  return false;
}
