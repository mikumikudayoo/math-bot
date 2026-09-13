import {qotdSettings} from '../qotd/config.js';
import {resetDevelopmentQotd} from '../qotd/reset.js';
try{const settings=qotdSettings();console.log(JSON.stringify(resetDevelopmentQotd(settings.database,process.cwd(),settings.mode,process.argv.includes('--discard-qotd-state'))));}
catch(error){console.error(error instanceof Error?error.message:error);process.exitCode=1;}
