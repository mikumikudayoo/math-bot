import { resolve } from 'node:path';
import { config } from 'dotenv';
export function qotdSettings() {
  const mode=process.env.BOT_ENV??'development';
  if(!['development','production'].includes(mode))throw new Error('Invalid BOT_ENV.');
  const env:NodeJS.ProcessEnv={};config({path:`.env.${mode}`,processEnv:env,quiet:true});
  const role=env.QOTD_ROLE_ID??process.env.QOTD_ROLE_ID;
  if(role&&!/^\d{17,20}$/.test(role))throw new Error('QOTD_ROLE_ID must be a Discord role ID.');
  return {mode,database:resolve(env.QOTD_DB_PATH??process.env.QOTD_DB_PATH??'data/qotd.sqlite'),assets:resolve(env.QOTD_ASSET_DIR??process.env.QOTD_ASSET_DIR??'data/qotd-assets'),role};
}
