import { config } from 'dotenv';

export function parseConfig(env: NodeJS.ProcessEnv, mode: string) {
  if (mode !== 'development' && mode !== 'production') throw new Error('BOT_ENV must be development or production.');
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Set ${key} in .env.${mode}.`);
    return value;
  };
  const snowflake = (key: string) => {
    const value = required(key);
    if (!/^\d{17,20}$/.test(value)) throw new Error(`${key} must be a Discord ID.`);
    return value;
  };
  const aiTesterUserIds = [...new Set((env.AI_TESTER_USER_IDS ?? '').split(',').map(id => id.trim()).filter(Boolean))];
  if (aiTesterUserIds.some(id => !/^\d{17,20}$/.test(id))) throw new Error('AI_TESTER_USER_IDS must be a comma-separated list of Discord user IDs.');
  return {
    mode,
    adminDatabase: env.ADMIN_DB_PATH?.trim() || `data/admin.${mode}.sqlite`,
    adminPython: env.ADMIN_PYTHON_EXECUTABLE?.trim() || 'python3',
    reminderDatabase: env.REMINDER_DB_PATH?.trim() || `data/reminders.${mode}.sqlite`,
    token: required('DISCORD_TOKEN'),
    applicationId: snowflake('DISCORD_APPLICATION_ID'),
    guildId: mode === 'development' ? snowflake('DISCORD_GUILD_ID') : undefined,
    serviceURL: env.AI_SERVICE_URL?.trim() || 'http://127.0.0.1:8787',
    serviceToken: env.AI_SERVICE_TOKEN?.trim() || '',
    messageFeatures: env.MESSAGE_FEATURES_ENABLED === 'true',
    aiTesterUserIds,
    coachRoles: (env.COACH_ROLE_IDS ?? '').split(',').map(x=>x.trim()).filter(Boolean),
    coachUsers: (env.COACH_USER_IDS ?? '').split(',').map(x=>x.trim()).filter(Boolean),
    modLogChannel: env.MOD_LOG_CHANNEL_ID?.trim() || '',
  };
}

export function loadConfig() {
  const mode = process.env.BOT_ENV ?? 'development';
  if (!['development', 'production'].includes(mode)) throw new Error('Invalid BOT_ENV.');
  // Isolated file values prevent inherited production credentials leaking into dev.
  const env: NodeJS.ProcessEnv = {};
  config({ path: `.env.${mode}`, processEnv: env, quiet: true });
  return parseConfig(env, mode);
}
