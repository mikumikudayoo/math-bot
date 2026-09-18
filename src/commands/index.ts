import { problem } from './problem.js';
import { problemAdmin } from './problem-admin.js';
import { qotd } from './qotd.js';
import { reminder } from './reminder.js';
import { sql } from './sql.js';
import { testers } from './testers.js';
import { qotdAdmin } from './qotd-admin.js';
import ping from './ping.js';
import { ask, calculate, plot, python, cancel, queue, ai } from './study.js';
import { filter } from './filter.js';
import type { Command } from './types.js';
import { loadConfig } from '../config.js';
import { authorizeAIInteraction, type AIAccessConfig } from '../ai-access.js';

export function loadCommands(modules: readonly Command[] = [ping,ask,calculate,plot,python,cancel,queue,ai,filter,qotd,reminder,sql,testers,qotdAdmin,problem,problemAdmin], config: () => AIAccessConfig = loadConfig) {
  const commands = new Map<string, Command>();
  for (const command of modules) {
    const { name } = command.data.toJSON();
    if (commands.has(name)) throw new Error(`Duplicate command: ${name}`);
    commands.set(name, command.access === 'ai-tester' ? {
      ...command,
      data: { toJSON: () => ({ ...command.data.toJSON(), default_member_permissions: '0' }) },
      async execute(interaction) {
        if (!await authorizeAIInteraction(interaction, config())) return;
        await command.execute(interaction);
      },
    } : command);
  }
  return commands;
}

export function commandJSON() {
  return JSON.stringify([...loadCommands().values()]
    .map(command => command.data.toJSON()).sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n';
}
