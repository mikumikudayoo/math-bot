import ping from './ping.js';
import { ask, calculate, plot, python, cancel, queue, ai } from './study.js';
import { filter } from './filter.js';
import { reactionRole } from './reaction-role.js';
import type { Command } from './types.js';

export function loadCommands(modules: readonly Command[] = [ping,ask,calculate,plot,python,cancel,queue,ai,filter,reactionRole]) {
  const commands = new Map<string, Command>();
  for (const command of modules) {
    const { name } = command.data.toJSON();
    if (commands.has(name)) throw new Error(`Duplicate command: ${name}`);
    commands.set(name, command);
  }
  return commands;
}

export function commandJSON() {
  return JSON.stringify([...loadCommands().values()]
    .map(command => command.data.toJSON()).sort((a, b) => a.name.localeCompare(b.name)), null, 2) + '\n';
}
