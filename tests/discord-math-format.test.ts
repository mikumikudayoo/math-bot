import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatDiscord,latexToText,splitDiscordMessage} from '../src/discord-format.js';

/** Table-driven: [name, input, exact expected Discord text]. */
const cases:[string,string,string][]=[
  // The production incident: \boxed and \tag lost only their backslash.
  ['boxed inline','so the only solution is $\\boxed{n=6}$.','so the only solution is **n=6**.'],
  ['boxed bare','final answer: \\boxed{n = 6}','final answer: **n = 6**'],
  ['tag in display','$$ (m-n)(m+n) = 2^{n} \\tag{1} $$','(m-n)(m+n) = 2ⁿ   (1)'],
  ['multi-line display with tag','\\[\n2^{a-1}(2^{d}-1) = 2a+d \\tag{2}\n\\]','2ᵃ⁻¹(2ᵈ-1) = 2a+d   (2)'],
  ['frac simple','$\\frac{1}{2}$','1/2'],
  ['frac compound denominator','$\\frac{a+b}{2a}$','(a+b)/(2a)'],
  ['frac nested','$\\frac{\\frac{1}{2}}{3}$','(1/2)/3'],
  ['quadratic formula','$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$','x = (-b ± √(b²-4ac))/(2a)'],
  ['dfrac and tfrac','$\\dfrac{1}{x} + \\tfrac{3}{4}$','1/x + 3/4'],
  ['nth root','$\\sqrt[3]{27}=3$','³√27=3'],
  ['subscripts','$a_n = a_{n-1} + a_{n-2}$','aₙ = aₙ₋₁ + aₙ₋₂'],
  ['unmappable subscript is escaped','$x_{max} + y_{\\alpha}$','xₘₐₓ + y\\_(α)'],
  ['superscript fallback','$e^{i\\pi}$','e^(iπ)'],
  ['degree','$90^\\circ$','90°'],
  ['blackboard','$x \\in \\mathbb{R}$','x ∈ ℝ'],
  ['binomial','$\\binom{5}{2}=10$','C(5, 2)=10'],
  ['pmod','$17 \\equiv 2 \\pmod{5}$','17 ≡ 2 (mod 5)'],
  ['text and operatorname','$\\text{if } n \\ge 1,\\ \\operatorname{lcm}(a,b)$','if n ≥ 1, lcm(a,b)'],
  ['floor and abs','$\\lfloor x \\rfloor + \\left| y \\right|$','⌊ x ⌋ + | y |'],
  ['accent single char','$\\bar{x}$','x̄'],
  ['unknown command keeps call shape','$\\unknowncmd{q}$','unknowncmd(q)'],
  ['escaped braces survive','$\\{1, 2\\}$','{1, 2}'],
  ['markdown in math is inert','$a*b*c$','a\\*b\\*c'],
  ['aligned block becomes code','$$\n\\begin{aligned}\nm - n &= 2^{a} \\\\\nm + n &= 2^{b}\n\\end{aligned}\n$$','```\nm - n = 2ᵃ\nm + n = 2ᵇ\n```'],
  ['bare aligned environment','\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}','```\nx = 1\ny = 2\n```'],
  ['cases','$|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}$','|x| = x if x ≥ 0\n-x if x < 0'],
  ['matrix','$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$','[1, 2]\n[3, 4]'],
  ['bare symbols in prose','so a \\le b \\implies a + c \\le b + c','so a ≤ b ⇒ a + c ≤ b + c'],
  // Preservation.
  ['inline code untouched','use `\\boxed{x}` in latex','use `\\boxed{x}` in latex'],
  ['fenced latex untouched','```latex\n\\boxed{n=6} \\tag{1}\n```','```latex\n\\boxed{n=6} \\tag{1}\n```'],
  ['money and paths untouched','price is $5 and $10, path C:\\Users\\me','price is $5 and $10, path C:\\Users\\me'],
  ['mass mention neutralized','ok @everyone look','ok @\u200beveryone look'],
  ['unterminated display still converted','text\n$$\n\\frac{1}{2} \\tag{3}','text\n1/2   (3)'],
];
for(const [name,input,expected] of cases)test('discord math: '+name,()=>assert.equal(formatDiscord(input),expected));

test('no LaTeX command residue survives conversion of realistic proof output',()=>{
  const proof=['Let $m^2 = n^2 + 2^n$. Then $(m-n)(m+n) = 2^n$ \\tag{1}.',
    '$$\\begin{aligned} m-n &= 2^{a} \\\\ m+n &= 2^{b} \\end{aligned}$$',
    'Since $b > a \\geq 1$, we get $n = 2^{b-1} - 2^{a-1}$, and $\\boxed{n=6}$.'].join('\n');
  const out=formatDiscord(proof);
  assert.doesNotMatch(out,/\\[a-zA-Z]|\b(?:tag|boxed|frac|begin|end)\{|[{}]/,out);
  assert.match(out,/\*\*n=6\*\*/);
});

test('every output line of converted math has balanced markdown and fences when split',()=>{
  const long=Array.from({length:120},(_,i)=>`$$\\begin{aligned} a_{${i}} &= \\frac{${i}}{2} \\\\ b &= \\boxed{${i}} \\end{aligned}$$\nstep ${i}: $x^{${i}}$`).join('\n');
  for(const part of splitDiscordMessage(formatDiscord(long))){
    assert.ok(part.length<=1900);
    assert.equal((part.match(/```/g)??[]).length%2,0,'fences balanced per message');
    assert.equal((part.replace(/```[\s\S]*?```/g,'').match(/\*\*/g)??[]).length%2,0,'bold balanced per message');
  }
});

test('plain conversion for code blocks uses brackets for boxes and no escapes',()=>{
  assert.equal(latexToText('\\boxed{a_{best}}',false),'[a_(best)]');
  assert.equal(latexToText('\\boxed{a_{best}}',true),'**a\\_(best)**');
});
