/** Discord measures message length in UTF-16 units. Leave room for existing delivery adapters. */
export const DISCORD_PART_LENGTH = 1900;

const symbols: Record<string, string> = {
  alpha:'α', beta:'β', gamma:'γ', delta:'δ', theta:'θ', lambda:'λ', mu:'μ', pi:'π', sigma:'σ',
  phi:'φ', omega:'ω', Delta:'Δ', Sigma:'Σ', Omega:'Ω', infty:'∞', sum:'∑', prod:'∏', int:'∫',
  pm:'±', mp:'∓', times:'×', cdot:'·', div:'÷', le:'≤', leq:'≤', ge:'≥', geq:'≥', neq:'≠',
  ne:'≠', approx:'≈', equiv:'≡', cong:'≅', sim:'∼', to:'→', rightarrow:'→', Rightarrow:'⇒',
  iff:'⇔', in:'∈', notin:'∉', cup:'∪', cap:'∩', forall:'∀', exists:'∃', ldots:'…',
  cdots:'⋯', left:'', right:'', quad:' ', qquad:'  ',
};
function math(text: string): string {
  let out = text;
  for (let depth = 0; depth < 12; depth++) {
    const next = out.replace(/\\(?:d?frac|tfrac)\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
      .replace(/\\(?:text|mathrm|mathbf|operatorname)\{([^{}]*)\}/g, '$1')
      .replace(/([_^])\{([^{}]*)\}/g, '$1($2)');
    if (next === out) break;
    out = next;
  }
  return out.replace(/\\([a-zA-Z]+)/g, (_, name: string) => symbols[name] ?? name)
    .replace(/\\[,;: ]/g, ' ').replace(/\\!/g, '').replace(/\\([{}%_$])/g, '$1');
}

function cells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/u).map(c => c.trim().replace(/\\\|/g, '|'));
}

function prose(line: string): string {
  // Inline code, Discord entities and URL autolinks keep their original contents.
  return line.split(/(`+[^`]+`+|<(?:https?:\/\/|[@#:])[^\s<>]+>)/g).map((part, index) => {
    if (index % 2) return part;
    return part
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(?:html|head|body|p|div|span|section|article|blockquote|aside|a|img|picture|video|audio|figure|figcaption|table|thead|tbody|tr|th|td|em|strong|b|i|u|ul|ol|li|code|pre|sup|sub|h[1-6]|script|style|iframe|svg|hr)(?:\s+[^>]*)?\/?>/gi, '')
      .replace(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|(?<![\\\w$])\$(?!\s)([^$\n]*?\S)\$(?![\w$])/g,
        (_, inline, display, double, single) => math(inline ?? display ?? double ?? single))
      .replace(/^(#{4,6})(?=\s)/, '###');
  }).join('');
}

/** Preserve code verbatim and translate pipe tables to labeled rows. */
export function formatDiscord(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let fence = false;
  let mathEnd = '';
  let mathLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) { fence = !fence; output.push(line); continue; }
    if (fence) { output.push(line); continue; }
    if (mathEnd) {
      if (line.trim() === mathEnd) { output.push(math(mathLines.join('\n'))); mathLines = []; mathEnd = ''; }
      else mathLines.push(line);
      continue;
    }
    if (line.trim() === '$$' || line.trim() === '\\[') { mathEnd = line.trim() === '$$' ? '$$' : '\\]'; continue; }
    const separator = lines[i + 1];
    if (line.includes('|') && separator?.includes('|')) {
      const header = cells(line), alignment = cells(separator);
      if (alignment.length === header.length && alignment.every(c => /^:?-{3,}:?$/.test(c))) {
        i++;
        const rows: string[][] = [];
        let valueLength = 0;
        while (lines[i + 1]?.includes('|')) {
          const values = cells(lines[i + 1]!);
          if (values.length !== header.length) break;
          valueLength += lines[i + 1]!.length;
          rows.push(values); i++;
        }
        const labels = header.map(prose);
        // A long header above many tiny rows must not be copied thousands of times.
        const repeatLabels = rows.length * (line.length + 5 * header.length) <= 100 + valueLength + line.length;
        if (!rows.length || !repeatLabels) output.push(labels.map(label => '**' + label + '**').join(' · '));
        for (const values of rows) output.push('- ' + values.map((value,j) =>
          (repeatLabels ? '**' + labels[j] + '** ' : '') + prose(value)).join(' · '));
        continue;
      }
    }
    output.push(prose(line));
  }
  if (mathEnd) output.push(math(mathLines.join('\n')));
  return output.join('\n').replace(/@(everyone|here)\b/gi, '@\u200b$1').trim();
}

function safeCut(text: string, length: number) {
  let end = Math.min(text.length, length);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
  return end;
}

/** A single equation or formatted link longer than one entire Discord message cannot
 * be split into messages without changing the expression or destination. Preserve the
 * complete original text as an attachment in that case. */
export function needsTextAttachment(text: string): boolean {
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced || line.length <= DISCORD_PART_LENGTH) continue;
    if (/[=≠≤≥∑∫√]|\\(?:\(|\[|frac|sqrt)|\$\$/.test(line)) return true;
    if (Array.from(line.matchAll(/\[[^\]\n]*\]\([^\s()]+\)|https?:\/\/\S+|`[^`\n]*`|\|\|(?:(?!\|\|).)*\|\|/gu))
      .some(match => match[0].length > DISCORD_PART_LENGTH)) return true;
  }
  return false;
}

/** Prefer complete lines/equations, then intact inline constructs, then word boundaries.
 * A code block that crosses a message boundary is closed and reopened with its language. */
export function splitDiscordMessage(text: string, limit = DISCORD_PART_LENGTH): string[] {
  if (!Number.isSafeInteger(limit) || limit < 64 || limit > 2000) throw new RangeError('invalid Discord message length');
  const parts: string[] = [];
  let open = '', chunk = '';
  const space = () => limit - chunk.length - (open ? 4 : 0);
  function flush() {
    const content = chunk.replace(/\n$/, '') + (open ? '\n```' : '');
    if (content.trim()) parts.push(content);
    chunk = open ? open + '\n' : '';
  }
  const lines = text.split('\n');
  for (const line of lines) {
    const boundary = line.match(/^\s*```([^`\n]{0,40})\s*$/);
    if (boundary) {
      if (open) { chunk += '```\n'; open = ''; }
      else {
        const marker = '```' + boundary[1]!.trim();
        if (marker.length + 7 > space()) flush();
        open = marker; chunk += marker + '\n';
      }
      continue;
    }
    // Preserve a whole line whenever it fits on a fresh page.
    const prefix = open ? open + '\n' : '';
    if (line.length + 1 > space() && chunk !== prefix) flush();
    if (line.length + 1 <= space()) { chunk += line + '\n'; continue; }
    const tokens = open ? line.match(/\s+|\S+/gu) : line.match(/\[[^\]\n]*\]\([^\s()]+\)|`[^`\n]*`|\|\|(?:(?!\|\|).)*\|\||\s+|\S+/gu);
    for (let token of tokens ?? []) {
      // An indivisible token larger than a full Discord message is cut at a Unicode boundary.
      if (token.length > space() && chunk !== prefix) flush();
      while (token.length > space()) {
        const end = safeCut(token, space());
        chunk += token.slice(0, end); flush(); token = token.slice(end);
      }
      chunk += token;
    }
    if (space() < 1) flush();
    chunk += '\n';
  }
  if (chunk && chunk !== (open ? open + '\n' : '')) flush();
  return parts.length ? parts : ['…'];
}
