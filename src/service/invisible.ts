/**
 * Invisible formatting characters that some clients insert inside words (production 2026-11-18:
 * every #ai-test prompt contained U+2060 WORD JOINER, e.g. "pr<U+2060>ov<U+2060>e"). They hid the
 * word "prove" from the proof-review trigger. Removed: soft hyphen U+00AD, zero width space U+200B,
 * word joiner and invisible operators U+2060-U+2064, and BOM/ZWNBSP U+FEFF. Kept: ZWJ/ZWNJ (emoji
 * and several scripts need them). The seven-agent U+2063 trigger is detected by the bot on the
 * original message before submission, so stripping it here cannot grant or remove that mode.
 */
const CODE_POINTS = [0x00ad, 0x200b, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff];
const INVISIBLE = new RegExp('[' + CODE_POINTS.map(c => String.fromCharCode(c)).join('') + ']', 'g');
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}
const ch = String.fromCharCode;
/** The broader set the embargo classifiers ignore (U+200B-U+200F, U+2060-U+206F, U+FEFF), for comparison only, never for display. */
const FORMAT_CONTROLS = new RegExp('[' + ch(0x200b) + '-' + ch(0x200f) + ch(0x2060) + '-' + ch(0x206f) + ch(0xfeff) + ']', 'g');
export const stripFormatControls = (text: string) => text.replace(FORMAT_CONTROLS, '');
