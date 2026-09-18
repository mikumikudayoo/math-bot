import { Competition } from './competition.js';
import { manilaDay, periods } from './periods.js';
export function leaderboardText(c: Competition, guild: string, day = manilaDay()) {
  const p = periods(day);
  const titles = {total:'Total Leaderboard',month:`Monthly Leaderboard · ${p.month}`,week:`Weekly Leaderboard · ${p.week} to ${p.weekEnd}`};
  return '**MPoTD Leaderboards**\n'+(['total','month','week'] as const).map(scope => {
    const rows = c.leaderboard(guild,scope,day);
    return `\n**${titles[scope]}**\n`+(rows.slice(0,10).map((r,i) => `${i+1}. <@${r.user}> · ${r.points} pts`).join('\n') || 'No scored submissions yet.');
  }).join('\n');
}
export function statsText(c: Competition, guild: string, user: string, day = manilaDay()) {
  const scopes = c.stats(guild,user,day), total = scopes[0]!.result;
  return `**MPoTD Stats for <@${user}>**\n\n`+scopes.map(s => `${s.scope}: ${s.points} points · rank ${s.rank ? '#'+s.rank : '—'}`).join('\n')+
    `\n\nCorrect: ${total?.correct ?? 0}\nSubmitted (scored days): ${total?.submitted ?? 0}\nAccuracy: ${total?.submitted ? (100*total.correct/total.submitted).toFixed(1) : '0.0'}%\n\n🥇 First-place finishes: ${total?.firsts ?? 0}\n🥈 Second-place finishes: ${total?.seconds ?? 0}\n🥉 Third-place finishes: ${total?.thirds ?? 0}`;
}
