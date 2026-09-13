import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { overrideImages } from "./crops.js";
import { QotdStore } from "./store.js";

export function createReviewServer(store:QotdStore, assets:string, port=8790, actor='local-review-ui') {
const token=randomUUID();
function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function fullQuestion(id: string) {
  const question = store.get(id);
  if (!question) return null;

  const occurrences = store.occurrences(id).map((occ) => ({
    ...occ,
    metadata: parseMaybeJson(occ.metadata),
    warnings: parseMaybeJson(occ.warnings),
    payload: parseMaybeJson(occ.payload),
  }));

  return {
    question,
    occurrences,
  };
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QOTD Review</title>

<style>
  :root {
    color-scheme: dark;
    font-family:
      Inter,
      ui-sans-serif,
      system-ui,
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      sans-serif;

    --bg: #111218;
    --panel: #191b23;
    --panel2: #20232d;
    --border: #303441;
    --text: #f2f3f5;
    --muted: #a7abb7;
    --accent: #8b8df8;
    --good: #4bc889;
    --bad: #ef6b73;
    --warn: #e6b450;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
  }

  button,
  select {
    font: inherit;
  }

  button {
    cursor: pointer;
  }

  header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 12px 18px;
    background: rgba(17, 18, 24, .95);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }

  header h1 {
    margin: 0;
    font-size: 18px;
  }

  header .spacer {
    flex: 1;
  }

  select,
  .smallbutton {
    border: 1px solid var(--border);
    background: var(--panel2);
    color: var(--text);
    border-radius: 8px;
    padding: 7px 10px;
  }

  #progress {
    color: var(--muted);
    font-size: 13px;
  }

  main {
    display: grid;
    grid-template-columns: minmax(420px, 1fr) minmax(380px, .9fr);
    min-height: calc(100vh - 58px);
  }

  .left,
  .right {
    padding: 22px;
  }

  .right {
    border-left: 1px solid var(--border);
    background: #0d0e13;
  }

  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px;
    margin-bottom: 16px;
  }

  .meta {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .question {
    white-space: pre-wrap;
    font-size: 17px;
    line-height: 1.6;
  }

  .solution {
    white-space: pre-wrap;
    line-height: 1.55;
  }

  .answer {
    white-space: pre-wrap;
    font-size: 16px;
  }

  .choices {
    display: grid;
    gap: 7px;
    margin-top: 15px;
  }

  .choice {
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--panel2);
  }

  .flags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .flag {
    border-radius: 999px;
    padding: 4px 8px;
    font-size: 12px;
    background: #3b3020;
    color: #ffd991;
  }

  .actions {
    position: sticky;
    bottom: 0;
    display: grid;
    grid-template-columns: 1fr 1fr .7fr;
    gap: 10px;
    padding: 14px 0 0;
    background: linear-gradient(transparent, var(--bg) 18%);
  }

  .action {
    border: 0;
    border-radius: 10px;
    padding: 13px;
    font-weight: 700;
    color: #fff;
  }

  .approve {
    background: #248a5c;
  }

  .reject {
    background: #b64049;
  }

  .skip {
    background: #424654;
  }

  .crop-image {display:block;max-width:100%;background:white;margin:12px 0;border-radius:8px;}
  .review-check {display:block;margin:12px 0;line-height:1.5;}
  iframe {
    width: 100%;
    height: calc(100vh - 115px);
    border: 1px solid var(--border);
    border-radius: 10px;
    background: white;
  }

  #empty {
    padding: 50px;
    text-align: center;
    color: var(--muted);
  }

  .hidden {
    display: none !important;
  }

  .error {
    border: 1px solid #723239;
    background: #351c20;
    padding: 12px;
    border-radius: 8px;
    color: #ffb7bb;
    margin-bottom: 15px;
  }

  kbd {
    background: #292c36;
    border: 1px solid #454957;
    border-bottom-width: 2px;
    border-radius: 5px;
    padding: 2px 5px;
    font-size: 11px;
  }

  @media (max-width: 900px) {
    main {
      display: block;
    }

    .right {
      border-left: 0;
      border-top: 1px solid var(--border);
    }

    iframe {
      height: 70vh;
    }
  }
</style>
</head>

<body>

<header>
  <h1>&#128218; QOTD Review</h1>

  <select id="state">
    <option value="pending">Pending</option>
    <option value="approved">Approved</option>
    <option value="rejected">Rejected</option>
  </select>

  <button class="smallbutton" id="prev">&#8592; Prev</button>
  <button class="smallbutton" id="next">Next &#8594;</button>

  <div class="spacer"></div>
  <div id="progress">Loading...</div>
</header>

<main id="app">
  <section class="left">
    <div id="error" class="error hidden"></div>

    <div id="content">
      <div class="card">
        <div id="meta" class="meta"></div>
      </div>

      <div class="card">
        <h3>Student-facing crop preview</h3>
        <div id="crops"></div><p id="cropStatus"></p>
        <label>Replace with question-only images in page order: <input id="images" type="file" accept="image/png,image/jpeg" multiple></label>
        <button class="smallbutton" id="replace">Upload replacements (revokes approval)</button>
      </div>
      <div class="card"><h3>Extracted text (internal only)</h3>
        <div id="question" class="question"></div>
        <div id="choices" class="choices"></div>
      </div>

      <div class="card">
        <h3>Official answer</h3>
        <div id="answer" class="answer"></div>
      </div>

      <div class="card">
        <h3>Official solution</h3>
        <div id="solution" class="solution"></div>
      </div>

      <div id="flagCard" class="card">
        <h3>Flags</h3>
        <div id="flags" class="flags"></div>
      </div>

      <div class="card">
        <label class="review-check"><input type="checkbox" id="sourceReviewed"> I checked the source, official fields, choices and duplicate/conflict flags.</label>
        <label class="review-check"><input type="checkbox" id="cropReviewed"> I checked every image: the entire question and its choices/diagrams are present, with no neighboring question, answer or solution.</label>
      </div>
      <details class="card"><summary>All source occurrences / conflicts</summary><pre id="occurrences" style="white-space:pre-wrap"></pre></details>
      <div class="actions">
        <button class="action approve" id="approve">
          Approve <kbd>A</kbd>
        </button>

        <button class="action reject" id="reject">
          Reject <kbd>R</kbd>
        </button>

        <button class="action skip" id="skip">
          Skip <kbd>S</kbd>
        </button>
      </div>
    </div>

    <div id="empty" class="hidden">
      &#127881; Nothing here.
    </div>
  </section>

  <section class="right">
    <label>Original source: <select id="sourceChoice"></select></label> <label>Page: <select id="sourcePageNumber"></select></label>
    <div id="sourceEmpty">
      No source PDF available.
    </div>

    <p><a id="sourceLink" target="_blank" rel="noopener">Open original PDF question page</a> &#183; <a id="solutionLink" target="_blank" rel="noopener">Open solution page</a></p>
    <img id="sourcePage" class="crop-image" alt="Original source page for review only">
    <iframe
      id="source"
      class="hidden"
      title="Source PDF"
    ></iframe>
  </section>
</main>

<script>
const reviewToken="__REVIEW_TOKEN__";
let state = "pending";
let items = [];
let index = 0;
let detail = null;

const $ = id => document.getElementById(id);

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(url, options) {
  const response = await fetch(url, {...options,headers:{...options?.headers,"X-Review-Token":reviewToken}});

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(body?.error ?? "Request failed");
  }

  return body;
}

async function refresh(preferredId = null) {
  $("error").classList.add("hidden");

  items = await api("/api/questions?state=" + encodeURIComponent(state));

  if (preferredId) {
    const found = items.findIndex(q => q.id === preferredId);
    if (found >= 0) index = found;
  }

  if (index >= items.length) {
    index = Math.max(0, items.length - 1);
  }

  await render();
}

async function render() {
  $("progress").textContent =
    items.length
      ? (index + 1) + " / " + items.length + " " + state
      : "0 " + state;

  if (!items.length) {
    $("content").classList.add("hidden");
    $("empty").classList.remove("hidden");
    $("source").classList.add("hidden");
    $("sourceEmpty").classList.remove("hidden");
    return;
  }

  $("content").classList.remove("hidden");
  $("empty").classList.add("hidden");

  const item = items[index];

  detail = await api(
    "/api/question/" + encodeURIComponent(item.id)
  );

  const q = detail.question;
  $("sourceReviewed").checked=false;$("cropReviewed").checked=false;
  $("crops").replaceChildren();
  for(const [i,image] of q.crop.images.entries()) {
    const img=document.createElement("img");img.className="crop-image";img.alt="Question crop "+(i+1);
    img.src="/api/crop/"+encodeURIComponent(q.id)+"/"+i;$("crops").appendChild(img);
  }
  $("cropStatus").textContent=q.crop.status+" · "+q.crop.flags.join("; ");
  $("occurrences").textContent=JSON.stringify(detail.occurrences,null,2);
  $("sourceChoice").replaceChildren();
  detail.occurrences.forEach((o,i)=>{const option=document.createElement("option");option.value=i;option.textContent=(i+1)+" · "+(o.metadata?.title||o.source);$("sourceChoice").appendChild(option);});
  const occ = detail.occurrences[0] ?? null;
  const metadata = occ?.metadata ?? {};

  $("meta").innerHTML = [
    "<b>ID:</b> " + esc(q.id),
    "<b>Type:</b> " + esc(q.kind),
    "<b>Competition:</b> " + esc(metadata.competition ?? "?"),
    "<b>Edition:</b> " + esc(metadata.edition ?? metadata.year ?? "?"),
    "<b>Level:</b> " + esc(metadata.level ?? "?"),
    "<b>Set:</b> " + esc(metadata.set ?? "?"),
    "<b>Section:</b> " + esc(q.section || "?"),
    "<b>Question:</b> #" + esc(q.number),
    "<b>Question page:</b> " + esc(q.questionPage),
    "<b>Solution page:</b> " + esc(q.solutionPage ?? "?"),
  ].join("<br>");

  $("question").textContent = q.text || "(no extracted text)";
  $("answer").textContent = q.officialAnswer || "(missing)";
  $("solution").textContent = q.officialSolution || "(missing)";

  $("choices").innerHTML = "";

  for (const choice of q.choices ?? []) {
    const element = document.createElement("div");
    element.className = "choice";

    const label = document.createElement("b");
    label.textContent = choice.label + ". ";

    element.appendChild(label);
    element.appendChild(
      document.createTextNode(choice.text)
    );

    $("choices").appendChild(element);
  }

  const flags = q.flags ?? [];

  $("flagCard").classList.toggle(
    "hidden",
    flags.length === 0
  );

  $("flags").innerHTML =
    flags.map(flag =>
      '<span class="flag">' + esc(flag) + "</span>"
    ).join("");

  function sourcePreview(rebuild=false) {
    const chosen=Number($("sourceChoice").value||0);const current=detail.occurrences[chosen];
    if(rebuild){$("sourcePageNumber").replaceChildren();for(let n=current.payload.questionPage;n<=current.payload.questionEndPage;n++){const option=document.createElement('option');option.value=n;option.textContent=n;$("sourcePageNumber").appendChild(option);}}
    const page=Number($("sourcePageNumber").value)||q.questionPage;
    $("sourcePage").src="/api/source-page/"+q.id+"/"+chosen+"/"+page;
    $("sourcePage").classList.remove("hidden");$("sourcePage").onerror=()=>$("sourcePage").classList.add("hidden");
    $("sourceLink").href="/api/source/"+q.id+"/"+chosen+"#page="+page;
    $("solutionLink").href="/api/source/"+q.id+"/"+chosen+"#page="+(current?.payload?.solutionPage||q.solutionPage||1);
  }
  $("sourceChoice").onchange=()=>sourcePreview(true);$("sourcePageNumber").onchange=()=>sourcePreview();
  if (occ) {sourcePreview(true);
    const page = q.questionPage || 1;

    $("source").src =
      "/api/source/" +
      encodeURIComponent(q.id) +
      "/0#page=" +
      encodeURIComponent(page);

    $("source").classList.add("hidden");
    $("sourceEmpty").classList.add("hidden");
  } else {
    $("source").classList.add("hidden");
    $("sourceEmpty").classList.remove("hidden");
  }
}

async function review(newState) {
  if (!detail) return;

  const id = detail.question.id;

  try {
    await api(
      "/api/review/" + encodeURIComponent(id),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: newState,
          acknowledgeSource:$("sourceReviewed").checked,
          acknowledgeCrop:$("cropReviewed").checked,
        }),
      }
    );

    await refresh();
  } catch (error) {
    $("error").textContent = error.message;
    $("error").classList.remove("hidden");
  }
}

function next() {
  if (!items.length) return;

  index = (index + 1) % items.length;
  render();
}

function prev() {
  if (!items.length) return;

  index = (index - 1 + items.length) % items.length;
  render();
}

$("sourceChoice").onchange=()=>{if(detail)$("source").src="/api/source/"+detail.question.id+"/"+$("sourceChoice").value+"#page="+detail.question.questionPage;};
$("replace").onclick=async()=>{
  if(!detail)return;
  try {const form=new FormData();for(const file of $("images").files)form.append("images",file);
    await api("/api/replace/"+detail.question.id,{method:"POST",body:form});await refresh(detail.question.id);
  }catch(error){$("error").textContent=error.message;$("error").classList.remove("hidden");}
};
$("approve").onclick = () => review("approved");
$("reject").onclick = () => review("rejected");
$("skip").onclick = next;
$("next").onclick = next;
$("prev").onclick = prev;

$("state").onchange = async event => {
  state = event.target.value;
  index = 0;
  await refresh();
};

document.addEventListener("keydown", event => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement
  ) return;

  const key = event.key.toLowerCase();

  if (key === "a") review("approved");
  if (key === "r") review("rejected");
  if (key === "s" || key === "j") next();
  if (key === "k") prev();
  if (event.key === "ArrowRight") next();
  if (event.key === "ArrowLeft") prev();
});

refresh().catch(error => {
  $("error").textContent = error.message;
  $("error").classList.remove("hidden");
});
</script>

</body>
</html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  maxRequestBodySize:81_000_000,

  async fetch(req) {
    const url = new URL(req.url);

    try {
      if(url.hostname!=="127.0.0.1" || req.headers.get('host')!==url.host) return json({error:'Local access only'},403);
      const origin=req.headers.get('origin');
      if(origin && origin!==url.origin)return json({error:'Foreign origin rejected'},403);
      if(req.method!=="GET" && req.headers.get('x-review-token')!==token)return json({error:'Review token required'},403);
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(HTML.replace("__REVIEW_TOKEN__",token), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      if (
        req.method === "GET" &&
        url.pathname === "/api/questions"
      ) {
        const state = url.searchParams.get("state") ?? "pending";

        if (
          state !== "pending" &&
          state !== "approved" &&
          state !== "rejected"
        ) {
          return json({ error: "Invalid state" }, 400);
        }

        return json(store.list(state, 10_000));
      }

      const questionMatch =
        url.pathname.match(/^\/api\/question\/([^/]+)$/);

      if (req.method === "GET" && questionMatch) {
        const id = decodeURIComponent(questionMatch[1]!);
        const data = fullQuestion(id);

        if (!data) {
          return json({ error: "Question not found" }, 404);
        }

        return json(data);
      }

      const sourceMatch =
        url.pathname.match(
          /^\/api\/source\/([^/]+)\/(\d+)$/
        );

      if (req.method === "GET" && sourceMatch) {
        const id = decodeURIComponent(sourceMatch[1]!);
        const occurrenceIndex = Number(sourceMatch[2]);

        const occurrences = store.occurrences(id);
        const occurrence =
          occurrences[occurrenceIndex];

        if (!occurrence) {
          return new Response("Source not found", {
            status: 404,
          });
        }

        const path = resolve(String(occurrence.asset));

        if (!existsSync(path)) {
          return new Response(
            "The source PDF is not available at:\\n" + path,
            {
              status: 404,
              headers: {
                "Content-Type": "text/plain; charset=utf-8",
              },
            }
          );
        }

        const file = Bun.file(path);

        return new Response(file, {
          headers: {
            "Content-Type": "application/pdf",
            "Cache-Control": "no-store",
          },
        });
      }

      const pageMatch=url.pathname.match(/^\/api\/source-page\/([a-f0-9]{64})\/(\d+)\/(\d+)$/);
      if(req.method==='GET' && pageMatch) {
        const source=store.occurrences(pageMatch[1]!)[Number(pageMatch[2])];
        if(!source)return json({error:'Source not found'},404);
        const image=resolve(dirname(String(source.asset)),'rendered-pages',`page-${Number(pageMatch[3])}.png`);
        if(!existsSync(image))return json({error:'Open the original PDF to inspect this page'},404);
        return new Response(Bun.file(image),{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}});
      }
      const cropMatch=url.pathname.match(/^\/api\/crop\/([a-f0-9]{64})\/(\d+)$/);
      if(req.method==='GET' && cropMatch) {
        const crop=store.get(cropMatch[1]!)?.crop.images[Number(cropMatch[2])];
        if(!crop || !existsSync(crop.path))return json({error:'Crop unavailable'},404);
        return new Response(Bun.file(crop.path),{headers:{'Content-Type':'image/png','Cache-Control':'no-store'}});
      }
      const replaceMatch=url.pathname.match(/^\/api\/replace\/([a-f0-9]{64})$/);
      if(req.method==='POST' && replaceMatch) {
        if(!store.get(replaceMatch[1]!))return json({error:'Question not found'},404);
        const form=await req.formData();const files=form.getAll('images');
        if(!files.length || files.length>10 || files.some(f=>typeof f==='string'))return json({error:'Choose 1–10 question-only image files'},400);
        const inputs=await Promise.all(files.map(async f=>new Uint8Array(await (f as File).arrayBuffer())));
        const dir=resolve(assets,'overrides');mkdirSync(dir,{recursive:true});
        store.replaceCrop(replaceMatch[1]!,await overrideImages(inputs,realpathSync(dir)),actor);
        return json({ok:true});
      }
      const reviewMatch =
        url.pathname.match(/^\/api\/review\/([^/]+)$/);

      if (req.method === "POST" && reviewMatch) {
        const id = decodeURIComponent(reviewMatch[1]!);

        const question = store.get(id);

        if (!question) {
          return json({ error: "Question not found" }, 404);
        }

        const body = await req.json() as {
          state?: string;
          acknowledgeSource?: boolean;
          acknowledgeCrop?: boolean;
        };

        if (
          body.state !== "approved" &&
          body.state !== "rejected"
        ) {
          return json(
            { error: "State must be approved or rejected" },
            400
          );
        }

        store.review(
          id,
          body.state,
          actor,
          body.acknowledgeSource === true,
          body.acknowledgeCrop === true
        );

        return json({
          ok: true,
          id,
          state: body.state,
        });
      }

      return new Response("Not found", {
        status: 404,
      });
    } catch (error) {


      return json(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        400
      );
    }
  },
});

return server;
}
