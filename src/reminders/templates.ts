import type { ReminderInput } from './types.js';
const headings={session:'session reminder',pretest:'pre-test / ClassMarker reminder',deadline:'registration / deadline reminder','update-roles':'staff role-update reminder',generic:'reminder'};
export function renderReminder(r:ReminderInput) {
  return {content:`⏰ ${headings[r.template]}${r.role?` · <@&${r.role}>`:''}\n${r.details}\nScheduled for <t:${Math.floor(r.due/1000)}:F>`,allowedMentions:{parse:[] as [],roles:r.role?[r.role]:[],users:[] as string[],repliedUser:false}};
}
