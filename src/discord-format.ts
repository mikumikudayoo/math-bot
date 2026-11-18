/** Discord measures message length in UTF-16 units. Leave room for existing delivery adapters. */
export const DISCORD_PART_LENGTH = 1900;

const symbols: Record<string, string> = {
  alpha:'α', beta:'β', gamma:'γ', delta:'δ', epsilon:'ε', varepsilon:'ε', zeta:'ζ', eta:'η', theta:'θ', vartheta:'ϑ',
  iota:'ι', kappa:'κ', lambda:'λ', mu:'μ', nu:'ν', xi:'ξ', pi:'π', rho:'ρ', sigma:'σ', tau:'τ', upsilon:'υ',
  phi:'φ', varphi:'φ', chi:'χ', psi:'ψ', omega:'ω', Gamma:'Γ', Delta:'Δ', Theta:'Θ', Lambda:'Λ', Xi:'Ξ', Pi:'Π',
  Sigma:'Σ', Phi:'Φ', Psi:'Ψ', Omega:'Ω', infty:'∞', sum:'∑', prod:'∏', int:'∫', oint:'∮', partial:'∂', nabla:'∇',
  pm:'±', mp:'∓', times:'×', cdot:'·', div:'÷', ast:'∗', le:'≤', leq:'≤', leqslant:'≤', ge:'≥', geq:'≥', geqslant:'≥',
  neq:'≠', ne:'≠', approx:'≈', equiv:'≡', cong:'≅', sim:'∼', simeq:'≃', propto:'∝', ll:'≪', gg:'≫',
  to:'→', rightarrow:'→', leftarrow:'←', Rightarrow:'⇒', implies:'⇒', Leftarrow:'⇐', impliedby:'⇐',
  iff:'⇔', Leftrightarrow:'⇔', leftrightarrow:'↔', mapsto:'↦', in:'∈', notin:'∉', ni:'∋', subset:'⊂', subseteq:'⊆',
  supset:'⊃', supseteq:'⊇', cup:'∪', cap:'∩', setminus:'∖', emptyset:'∅', varnothing:'∅', forall:'∀', exists:'∃',
  neg:'¬', lnot:'¬', land:'∧', wedge:'∧', lor:'∨', vee:'∨', mid:'∣', nmid:'∤', parallel:'∥', perp:'⊥', angle:'∠',
  triangle:'△', circ:'∘', degree:'°', prime:'′', ldots:'…', dots:'…', cdots:'⋯', vdots:'⋮', ddots:'⋱',
  lfloor:'⌊', rfloor:'⌋', lceil:'⌈', rceil:'⌉', langle:'⟨', rangle:'⟩', therefore:'∴', because:'∵', qed:'∎',
  bmod:'mod', mod:'mod', left:'', right:'', bigl:'', bigr:'', Bigl:'', Bigr:'', big:'', Big:'', displaystyle:'', textstyle:'',
  limits:'', nolimits:'', quad:' ', qquad:'  ', hfill:' ',
};
const SUP: Record<string,string> = {'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','−':'⁻','=':'⁼','(':'⁽',')':'⁾',
  a:'ᵃ',b:'ᵇ',c:'ᶜ',d:'ᵈ',e:'ᵉ',f:'ᶠ',g:'ᵍ',h:'ʰ',i:'ⁱ',j:'ʲ',k:'ᵏ',l:'ˡ',m:'ᵐ',n:'ⁿ',o:'ᵒ',p:'ᵖ',r:'ʳ',s:'ˢ',t:'ᵗ',u:'ᵘ',v:'ᵛ',w:'ʷ',x:'ˣ',y:'ʸ',z:'ᶻ'};
const SUB: Record<string,string> = {'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','−':'₋','=':'₌','(':'₍',')':'₎',
  a:'ₐ',e:'ₑ',h:'ₕ',i:'ᵢ',j:'ⱼ',k:'ₖ',l:'ₗ',m:'ₘ',n:'ₙ',o:'ₒ',p:'ₚ',r:'ᵣ',s:'ₛ',t:'ₜ',u:'ᵤ',v:'ᵥ',x:'ₓ'};
const BB: Record<string,string> = {R:'ℝ',N:'ℕ',Z:'ℤ',Q:'ℚ',C:'ℂ',P:'ℙ'};
/** Commands with dedicated multi-argument handling; the generic fallback must wait for them. */
const HANDLED = /^(?:boxed|tag|[dt]?frac|[dt]?binom|sqrt|text\w*|math\w*|boldsymbol|operatorname|mbox|hbox|overline|bar|vec|hat|tilde|dot|ddot|pmod|begin|end)$/;
/** Groups contain no braces; repeated passes resolve nesting from the inside out. */
const G = '\\{([^{}]*)\\}';
/** One number, one letter (with primes) or one symbol. `2a` is a product, so it is wrapped: (2a). */
const simple = (v: string) => /^√?(?:\p{N}+(?:\.\p{N}+)?|\p{L}[′']*)$|^[^\s+\-*/=<>]$/u.test(v.trim());
const wrap = (v: string) => simple(v) ? v.trim() : '(' + v.trim() + ')';
function script(map: Record<string,string>, mark: string, raw: string) {
  const v = raw.trim();
  if (v === '\\circ' && mark === '^') return '°';
  return [...v].every(c => map[c]) ? [...v].map(c => map[c]).join('') : mark + wrap(v);
}
// Placeholders keep conversion output away from Markdown escaping; they never appear in output.
const BOX_OPEN = '\u0001', BOX_CLOSE = '\u0002', LBRACE = '\u0003', RBRACE = '\u0004', TAG = '\u0005';
const ENVIRONMENT = /\\begin\{(aligned|align\*?|alignat\*?|gathered|gather\*?|split|eqnarray\*?|multline\*?|cases|dcases|[pbvBV]?matrix|smallmatrix|array)\}(?:\{[^{}]*\})?([\s\S]*?)\\end\{\1\}/g;
function environments(text: string) {
  return text.replace(ENVIRONMENT, (_, name: string, body: string) => {
    const rows = body.split(/\\\\(?:\[[^\]]*\])?/).map(r => r.replace(/\\hline/g, '').trim()).filter(Boolean);
    if (/cases/.test(name)) return rows.map(r => { const [value, ...cond] = r.split(/(?<!\\)&/); return value!.trim() + (cond.length ? ' if ' + cond.join(' ').replace(/^\s*\\?(?:text\{)?\s*if\s*/,'').trim() : ''); }).join('\n');
    if (/matrix|array/.test(name)) return rows.map(r => '[' + r.split(/(?<!\\)&/).map(c => c.trim()).join(', ') + ']').join('\n');
    return rows.map(r => r.replace(/(?<!\\)&/g, ' ').replace(/\s+/g, ' ').trim()).join('\n');
  });
}
/**
 * LaTeX math -> readable Unicode/plain text for Discord, which renders no LaTeX.
 * Unknown commands lose only their backslash and grouping braces (never `name{...}`).
 * With `escape`, Markdown-active characters are escaped and \boxed becomes bold.
 */
export function latexToText(text: string, escape = true): string {
  let out = environments(text).replace(/\\\\(?:\[[^\]]*\])?/g, '\n').replace(/\\\{/g, LBRACE).replace(/\\\}/g, RBRACE);
  for (let depth = 0; depth < 16; depth++) {
    const next = out
      .replace(new RegExp('\\\\boxed\\s*' + G, 'g'), (_, v: string) => BOX_OPEN + v.trim() + BOX_CLOSE)
      .replace(new RegExp('\\\\tag\\*?\\s*' + G, 'g'), (_, v: string) => TAG + '(' + v.trim() + ')')
      .replace(new RegExp('\\\\[dt]?frac\\s*' + G + '\\s*' + G, 'g'), (_, a: string, b: string) => wrap(a) + '/' + wrap(b))
      .replace(new RegExp('\\\\[dt]?binom\\s*' + G + '\\s*' + G, 'g'), (_, n: string, k: string) => 'C(' + n.trim() + ', ' + k.trim() + ')')
      .replace(new RegExp('\\\\sqrt\\s*\\[([^\\]]*)\\]\\s*' + G, 'g'), (_, n: string, v: string) => script(SUP, '', n).replace(/^\(|\)$/g,'') + '√' + wrap(v))
      .replace(new RegExp('\\\\sqrt\\s*' + G, 'g'), (_, v: string) => '√' + wrap(v))
      .replace(new RegExp('\\\\(?:text|textbf|textit|textrm|textup|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathfrak|boldsymbol|operatorname\\*?|mbox|hbox)\\s*' + G, 'g'), '$1')
      .replace(new RegExp('\\\\mathbb\\s*' + G, 'g'), (_, v: string) => BB[v.trim()] ?? v)
      .replace(new RegExp('\\\\(overline|bar|vec|hat|tilde|dot|ddot)\\s*' + G, 'g'), (_, accent: string, v: string) => {
        const mark = ({overline:'̅', bar:'̄', vec:'⃗', hat:'̂', tilde:'̃', dot:'̇', ddot:'̈'} as Record<string,string>)[accent]!;
        return [...v.trim()].length === 1 ? v.trim() + mark : accent + '(' + v.trim() + ')';
      })
      .replace(new RegExp('\\\\pmod\\s*' + G, 'g'), (_, v: string) => ' (mod ' + v.trim() + ')')
      .replace(new RegExp('\\^\\s*' + G, 'g'), (_, v: string) => script(SUP, '^', v))
      .replace(new RegExp('_\\s*' + G, 'g'), (_, v: string) => script(SUB, '_', v))
      // Any other command applied to a group keeps a readable call shape, never `name{...}` or `nameq`.
      .replace(new RegExp('\\\\([a-zA-Z]+)\\*?\\s*' + G, 'g'), (m, name: string, v: string) =>
        HANDLED.test(name) ? m : name in symbols ? symbols[name] + ' ' + v : name + '(' + v.trim() + ')');
    if (next === out) break;
    out = next;
  }
  out = out
    .replace(/\^\s*\\circ\b/g, '°')
    .replace(/\^([0-9A-Za-z])/g, (_, c: string) => SUP[c] ?? '^' + c)
    .replace(/_([0-9A-Za-z])(?![0-9A-Za-z])/g, (m, c: string) => SUB[c] ?? m)
    .replace(/\\([a-zA-Z]+)\*?/g, (_, name: string) => symbols[name] ?? name)
    .replace(/\\[,;: >]/g, ' ').replace(/\\!/g, '').replace(/\\([%_$&#])/g, '$1')
    .replace(/[{}]/g, '').replace(new RegExp(LBRACE,'g'), '{').replace(new RegExp(RBRACE,'g'), '}')
    .replace(/[ \t]{2,}/g, ' ').split('\n').map(l => l.trim()).join('\n').trim()
    .replace(new RegExp('\\s*' + TAG, 'g'), '   ');
  if (escape) out = out.replace(/([*_~`\\])/g, '\\$1').replace(/\|\|/g, '|\\|');
  return out.replace(new RegExp(BOX_OPEN + '([^' + BOX_CLOSE + ']*)' + BOX_CLOSE, 'g'), (_, v: string) => escape ? '**' + v + '**' : '[' + v + ']');
}
const math = (text: string) => latexToText(text, true);
/** Multi-line display math keeps its alignment in a code block, where Markdown is inert. */
function displayMath(source: string): string[] {
  const plain = latexToText(source, false);
  return plain.includes('\n') ? ['```', ...plain.split('\n'), '```'] : [latexToText(source, true)];
}
/** Known LaTeX written outside math delimiters. Unknown backslash words (paths, escapes) stay as written. */
const BARE_STRUCTURE = /\\(?:boxed|tag|[dt]?frac|[dt]?binom|sqrt|text|mathbb|mathrm|mathbf|operatorname|pmod|overline)\s*(?:\[[^\]\n]*\])?(?:\{(?:[^{}\n]|\{(?:[^{}\n]|\{[^{}\n]*\})*\})*\}\s*){1,2}/g;
const BARE_SYMBOL = new RegExp('\\\\(' + Object.keys(symbols).filter(k => symbols[k]).sort((a,b)=>b.length-a.length).join('|') + ')(?![a-zA-Z])', 'g');
function bareLatex(part: string) {
  if (!part.includes('\\') && !/\^\{/.test(part)) return part;
  return part.replace(BARE_STRUCTURE, m => math(m)).replace(BARE_SYMBOL, (_, name: string) => symbols[name]!)
    .replace(/\^\{([^{}\n]{1,40})\}/g, (_, v: string) => script(SUP, '^', v));
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
  }).map((part, index) => index % 2 ? part : bareLatex(part)).join('');
}
const ENV_START = /^\s*\\begin\{(aligned|align\*?|alignat\*?|gathered|gather\*?|split|eqnarray\*?|multline\*?|cases|dcases|[pbvBV]?matrix|array)\}/;

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
      const environmentEnd = mathEnd.startsWith('\\end{');
      if (environmentEnd ? line.includes(mathEnd) : line.trim() === mathEnd) {
        if (environmentEnd) mathLines.push(line);
        output.push(...displayMath(mathLines.join('\n'))); mathLines = []; mathEnd = '';
      }
      else mathLines.push(line);
      continue;
    }
    if (line.trim() === '$$' || line.trim() === '\\[') { mathEnd = line.trim() === '$$' ? '$$' : '\\]'; continue; }
    // A bare multi-line environment (no $$ / \[ wrapper) is display math too.
    const environment = line.match(ENV_START);
    if (environment && !line.includes('\\end{' + environment[1] + '}')) { mathEnd = '\\end{' + environment[1] + '}'; mathLines = [line]; continue; }
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
  // An unterminated display block (e.g. a truncated stream) is still converted, never left raw.
  if (mathEnd) output.push(...displayMath(mathLines.join('\n')));
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
