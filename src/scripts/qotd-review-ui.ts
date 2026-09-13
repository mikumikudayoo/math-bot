import {createReviewServer} from '../qotd/review-ui.js';
import {QotdStore} from '../qotd/store.js';
import {qotdSettings} from '../qotd/config.js';
const settings=qotdSettings();const store=new QotdStore(settings.database);
const server=createReviewServer(store,settings.assets,Number(process.env.QOTD_REVIEW_PORT??8790),process.env.USER??process.env.USERNAME??'local-review-ui');
console.log(`QOTD crop review: http://127.0.0.1:${server.port}\nDatabase: ${settings.database}\nReview all crops before approving. Ctrl+C to stop.`);
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.stop(true);store.close();});
