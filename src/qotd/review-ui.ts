import {
  resolve,
  dirname,
} from 'node:path';

import {
  existsSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';

import {
  randomUUID,
} from 'node:crypto';

import {
  overrideImages,
} from './crops.js';

import {
  QotdStore,
} from './store.js';

export interface ReviewServerOptions {
  port?: number;
  host?: string;
  reviewers?: string[];
  claimTtlMs?: number;
}

export function createReviewServer(
  store: QotdStore,
  assets: string,
  optionsOrPort:
    | ReviewServerOptions
    | number = 8790,
  legacyActor = 'local-review-ui',
) {
  /*
   * Keep compatibility with older tests/callers which used:
   *
   * createReviewServer(store, assets, port, actor)
   */
  const legacyMode =
    typeof optionsOrPort === 'number';

  const options: ReviewServerOptions =
    legacyMode
      ? {
          port: optionsOrPort,
          host: '127.0.0.1',
          reviewers: [legacyActor],
        }
      : optionsOrPort;

  const host =
    options.host ??
    '127.0.0.1';

  const port =
    options.port ??
    8790;

  const reviewers = [
    ...new Set(
      (
        options.reviewers?.length
          ? options.reviewers
          : [legacyActor]
      )
        .map((value) =>
          value.trim(),
        )
        .filter(Boolean),
    ),
  ];

  const reviewerSet =
    new Set(reviewers);

  const claimTtlMs =
    options.claimTtlMs ??
    15 * 60 * 1000;

  const token = randomUUID();

  function json(
    data: unknown,
    status = 200,
  ) {
    return Response.json(data, {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }

  function parseMaybeJson(
    value: unknown,
  ) {
    if (
      typeof value !== 'string'
    ) {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  function reviewerFrom(
    req: Request,
  ) {
    const reviewer =
      req.headers
        .get('x-reviewer')
        ?.trim() ??
      '';

    if (!reviewer && legacyMode) {
      return reviewers[0]!;
    }

    if (
      !reviewer ||
      !reviewerSet.has(reviewer)
    ) {
      throw new Error(
        'Choose a valid reviewer first.',
      );
    }

    return reviewer;
  }

  function fullQuestion(
    id: string,
  ) {
    const question =
      store.get(id);

    if (!question) {
      return null;
    }

    const occurrences =
      store
        .occurrences(id)
        .map((occurrence) => ({
          ...occurrence,

          metadata:
            parseMaybeJson(
              occurrence.metadata,
            ),

          warnings:
            parseMaybeJson(
              occurrence.warnings,
            ),

          payload:
            parseMaybeJson(
              occurrence.payload,
            ),
        }));

    return {
      question,
      occurrences,
      reviewClaim:
        store.reviewClaim(id),
    };
  }

  const HTML = String.raw`
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>
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
select,
input {
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: .45;
}

header {
  position: sticky;
  top: 0;
  z-index: 20;

  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;

  padding: 12px 18px;

  background:
    rgba(17,18,24,.95);

  backdrop-filter:
    blur(10px);

  border-bottom:
    1px solid var(--border);
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
  border:
    1px solid var(--border);

  background:
    var(--panel2);

  color:
    var(--text);

  border-radius:
    8px;

  padding:
    7px 10px;
}

.status {
  color:
    var(--muted);

  font-size:
    13px;
}

#claimStatus {
  padding:
    5px 9px;

  border-radius:
    999px;

  background:
    var(--panel2);

  font-size:
    12px;
}

#claimStatus.mine {
  color:
    #9af0c5;

  border:
    1px solid #286844;
}

#claimStatus.other {
  color:
    #ffd991;

  border:
    1px solid #71592b;
}

main {
  display: grid;

  grid-template-columns:
    minmax(420px,1fr)
    minmax(380px,.9fr);

  min-height:
    calc(100vh - 58px);
}

.left,
.right {
  padding:
    22px;
}

.right {
  border-left:
    1px solid var(--border);

  background:
    #0d0e13;
}

.card {
  background:
    var(--panel);

  border:
    1px solid var(--border);

  border-radius:
    12px;

  padding:
    18px;

  margin-bottom:
    16px;
}

.meta {
  color:
    var(--muted);

  font-size:
    13px;

  line-height:
    1.6;
}

.question {
  white-space:
    pre-wrap;

  font-size:
    17px;

  line-height:
    1.6;
}

.solution,
.answer {
  white-space:
    pre-wrap;

  line-height:
    1.55;
}

.choices {
  display: grid;

  gap: 7px;

  margin-top:
    15px;
}

.choice {
  padding:
    10px 12px;

  border-radius:
    8px;

  background:
    var(--panel2);
}

.flags {
  display: flex;

  flex-wrap: wrap;

  gap: 6px;
}

.flag {
  border-radius:
    999px;

  padding:
    4px 8px;

  font-size:
    12px;

  background:
    #3b3020;

  color:
    #ffd991;
}

.actions {
  position: sticky;
  bottom: 0;

  display: grid;

  grid-template-columns:
    1fr 1fr .7fr;

  gap:
    10px;

  padding:
    14px 0 0;

  background:
    linear-gradient(
      transparent,
      var(--bg) 18%
    );
}

.action {
  border: 0;

  border-radius:
    10px;

  padding:
    13px;

  font-weight:
    700;

  color:
    #fff;
}

.approve {
  background:
    #248a5c;
}

.reject {
  background:
    #b64049;
}

.skip {
  background:
    #424654;
}

.crop-image {
  display: block;

  max-width:
    100%;

  background:
    white;

  margin:
    12px 0;

  border-radius:
    8px;
}

.review-check {
  display: block;

  margin:
    12px 0;

  line-height:
    1.5;
}

iframe {
  width: 100%;

  height:
    calc(100vh - 115px);

  border:
    1px solid var(--border);

  border-radius:
    10px;

  background:
    white;
}

#empty {
  padding:
    50px;

  text-align:
    center;

  color:
    var(--muted);
}

.hidden {
  display:
    none !important;
}

.error {
  border:
    1px solid #723239;

  background:
    #351c20;

  padding:
    12px;

  border-radius:
    8px;

  color:
    #ffb7bb;

  margin-bottom:
    15px;
}

kbd {
  background:
    #292c36;

  border:
    1px solid #454957;

  border-bottom-width:
    2px;

  border-radius:
    5px;

  padding:
    2px 5px;

  font-size:
    11px;
}

@media (max-width: 900px) {
  main {
    display:
      block;
  }

  .right {
    border-left:
      0;

    border-top:
      1px solid var(--border);
  }

  iframe {
    height:
      70vh;
  }
}
</style>
</head>

<body>

<header>
  <h1>📚 QOTD Review</h1>

  <label>
    Reviewer:
    <select id="reviewer">
      <option value="">
        Choose...
      </option>
    </select>
  </label>

  <select id="state">
    <option value="pending">
      Pending
    </option>

    <option value="approved">
      Approved
    </option>

    <option value="rejected">
      Rejected
    </option>
  </select>

  <button
    class="smallbutton"
    id="prev"
  >
    ← Prev
  </button>

  <button
    class="smallbutton"
    id="next"
  >
    Next →
  </button>

  <div class="spacer"></div>

  <div
    id="claimStatus"
    class="hidden"
  ></div>

  <div
    id="stats"
    class="status"
  ></div>

  <div
    id="progress"
    class="status"
  >
    Loading...
  </div>
</header>

<main id="app">
<section class="left">

<div
  id="error"
  class="error hidden"
></div>

<div id="content">

<div class="card">
  <div
    id="meta"
    class="meta"
  ></div>
</div>

<div class="card">
  <h3>
    Student-facing crop preview
  </h3>

  <div id="crops"></div>

  <p id="cropStatus"></p>

  <label>
    Replace with question-only
    images in page order:

    <input
      id="images"
      type="file"
      accept="image/png,image/jpeg"
      multiple
    >
  </label>

  <button
    class="smallbutton"
    id="replace"
  >
    Upload replacements
    (revokes approval)
  </button>
</div>

<div class="card">
  <h3>
    Extracted text
    (internal only)
  </h3>

  <div
    id="question"
    class="question"
  ></div>

  <div
    id="choices"
    class="choices"
  ></div>
</div>

<div class="card">
  <h3>Official answer</h3>

  <div
    id="answer"
    class="answer"
  ></div>
</div>

<div class="card">
  <h3>Official solution</h3>

  <div
    id="solution"
    class="solution"
  ></div>
</div>

<div
  id="flagCard"
  class="card"
>
  <h3>Flags</h3>

  <div
    id="flags"
    class="flags"
  ></div>
</div>

<div class="card">

<label class="review-check">
  <input
    type="checkbox"
    id="sourceReviewed"
  >

  I checked the source,
  official fields,
  choices and
  duplicate/conflict flags.
</label>

<label class="review-check">
  <input
    type="checkbox"
    id="cropReviewed"
  >

  I checked every image:
  the entire question and
  its choices/diagrams are
  present, with no neighboring
  question, answer or solution.
</label>

</div>

<details class="card">
  <summary>
    All source occurrences /
    conflicts
  </summary>

  <pre
    id="occurrences"
    style="white-space:pre-wrap"
  ></pre>
</details>

<div class="actions">

<button
  class="action approve"
  id="approve"
>
  Approve <kbd>A</kbd>
</button>

<button
  class="action reject"
  id="reject"
>
  Reject <kbd>R</kbd>
</button>

<button
  class="action skip"
  id="skip"
>
  Skip <kbd>S</kbd>
</button>

</div>
</div>

<div
  id="empty"
  class="hidden"
>
  🎉 Nothing here.
</div>

</section>

<section class="right">

<label>
  Original source:

  <select
    id="sourceChoice"
  ></select>
</label>

<label>
  Page:

  <select
    id="sourcePageNumber"
  ></select>
</label>

<div id="sourceEmpty">
  No source PDF available.
</div>

<p>
  <a
    id="sourceLink"
    target="_blank"
    rel="noopener"
  >
    Open original PDF
    question page
  </a>

  ·

  <a
    id="solutionLink"
    target="_blank"
    rel="noopener"
  >
    Open solution page
  </a>
</p>

<img
  id="sourcePage"
  class="crop-image"
  alt="Original source page for review only"
>

<iframe
  id="source"
  class="hidden"
  title="Source PDF"
></iframe>

</section>
</main>

<script>
const reviewToken="__REVIEW_TOKEN__";

let state =
  "pending";

let items =
  [];

let index =
  0;

let detail =
  null;

let currentClaimedId =
  null;

let claimRefreshTimer =
  null;

const $ =
  id =>
    document.getElementById(id);

function reviewer() {
  return (
    localStorage.getItem(
      "qotd-reviewer"
    ) ??
    ""
  );
}

function esc(value) {
  return String(value ?? "")
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    );
}

function showError(error) {
  $("error").textContent =
    error instanceof Error
      ? error.message
      : String(error);

  $("error").classList.remove(
    "hidden"
  );
}

function clearError() {
  $("error").classList.add(
    "hidden"
  );
}

async function api(
  url,
  options = {},
) {
  const headers = {
    ...(options.headers ?? {}),
    "X-Review-Token":
      reviewToken,
  };

  const currentReviewer =
    reviewer();

  if (currentReviewer) {
    headers["X-Reviewer"] =
      currentReviewer;
  }

  const response =
    await fetch(
      url,
      {
        ...options,
        headers,
      },
    );

  const body =
    await response
      .json()
      .catch(
        () => null,
      );

  if (!response.ok) {
    throw new Error(
      body?.error ??
      "Request failed",
    );
  }

  return body;
}

async function loadReviewers() {
  const data =
    await api(
      "/api/reviewers",
    );

  $("reviewer")
    .replaceChildren();

  const placeholder =
    document.createElement(
      "option",
    );

  placeholder.value =
    "";

  placeholder.textContent =
    "Choose...";

  $("reviewer")
    .appendChild(
      placeholder,
    );

  for (
    const name of data.reviewers
  ) {
    const option =
      document.createElement(
        "option",
      );

    option.value =
      name;

    option.textContent =
      name;

    $("reviewer")
      .appendChild(
        option,
      );
  }

  const saved =
    reviewer();

  if (
    data.reviewers.includes(
      saved,
    )
  ) {
    $("reviewer").value =
      saved;
  } else {
    localStorage.removeItem(
      "qotd-reviewer",
    );
  }
}

async function updateStats() {
  const stats =
    await api(
      "/api/stats",
    );

  $("stats").textContent =
    "Pending " +
    stats.pending +
    " · Approved " +
    stats.approved +
    " · Rejected " +
    stats.rejected +
    " · In review " +
    stats.inReview;
}

async function releaseCurrent() {
  if (
    !currentClaimedId ||
    !reviewer()
  ) {
    currentClaimedId =
      null;

    return;
  }

  const id =
    currentClaimedId;

  currentClaimedId =
    null;

  if (claimRefreshTimer) {
    clearInterval(
      claimRefreshTimer,
    );

    claimRefreshTimer =
      null;
  }

  try {
    await api(
      "/api/release/" +
      encodeURIComponent(id),
      {
        method:
          "POST",
      },
    );
  } catch {
    /*
     * Losing/releasing an expired claim
     * is harmless.
     */
  }
}

function startClaimRefresh(id) {
  if (claimRefreshTimer) {
    clearInterval(
      claimRefreshTimer,
    );
  }

  claimRefreshTimer =
    setInterval(
      async () => {
        if (
          currentClaimedId !== id
        ) {
          return;
        }

        try {
          await api(
            "/api/claim/" +
            encodeURIComponent(id) +
            "/refresh",
            {
              method:
                "POST",
            },
          );
        } catch (error) {
          showError(error);

          currentClaimedId =
            null;

          clearInterval(
            claimRefreshTimer,
          );

          claimRefreshTimer =
            null;

          await refresh();
        }
      },
      5 * 60 * 1000,
    );
}

async function refresh(
  preferredId = null,
) {
  clearError();

  await updateStats();

  if (
    state === "pending" &&
    !reviewer()
  ) {
    items = [];
    detail = null;

    $("content")
      .classList.add(
        "hidden",
      );

    $("empty")
      .classList.remove(
        "hidden",
      );

    $("empty").textContent =
      "Choose your reviewer name first.";

    $("progress").textContent =
      "Reviewer required";

    return;
  }

  items =
    await api(
      "/api/questions?state=" +
      encodeURIComponent(
        state,
      ),
    );

  if (preferredId) {
    const found =
      items.findIndex(
        (question) =>
          question.id ===
          preferredId,
      );

    if (found >= 0) {
      index = found;
    }
  }

  if (index >= items.length) {
    index =
      Math.max(
        0,
        items.length - 1,
      );
  }

  await render();
}

async function render() {
  $("progress").textContent =
    items.length
      ? (
          index +
          1 +
          " / " +
          items.length +
          " " +
          state
        )
      : (
          "0 " +
          state
        );

  if (!items.length) {
    $("content")
      .classList.add(
        "hidden",
      );

    $("empty")
      .classList.remove(
        "hidden",
      );

    $("empty").textContent =
      state === "pending"
        ? "🎉 No unclaimed pending questions available."
        : "🎉 Nothing here.";

    $("source")
      .classList.add(
        "hidden",
      );

    $("sourceEmpty")
      .classList.remove(
        "hidden",
      );

    $("claimStatus")
      .classList.add(
        "hidden",
      );

    return;
  }

  $("content")
    .classList.remove(
      "hidden",
    );

  $("empty")
    .classList.add(
      "hidden",
    );

  const item =
    items[index];

  if (
    state === "pending"
  ) {
    try {
      const claimed =
        await api(
          "/api/claim/" +
          encodeURIComponent(
            item.id,
          ),
          {
            method:
              "POST",
          },
        );

      currentClaimedId =
        item.id;

      startClaimRefresh(
        item.id,
      );

      $("claimStatus")
        .className =
        "mine";

      $("claimStatus")
        .textContent =
        "Reviewing as " +
        claimed.claim.actor;
    } catch (error) {
      showError(error);

      await refresh();

      return;
    }
  } else {
    currentClaimedId =
      null;

    $("claimStatus")
      .classList.add(
        "hidden",
      );
  }

  detail =
    await api(
      "/api/question/" +
      encodeURIComponent(
        item.id,
      ),
    );

  const q =
    detail.question;

  const canReview =
    state === "pending" &&
    currentClaimedId === q.id;

  $("approve").disabled =
    !canReview;

  $("reject").disabled =
    !canReview;

  $("sourceReviewed").checked =
    false;

  $("cropReviewed").checked =
    false;

  $("crops")
    .replaceChildren();

  for (
    const [
      imageIndex,
    ] of q.crop.images.entries()
  ) {
    const img =
      document.createElement(
        "img",
      );

    img.className =
      "crop-image";

    img.alt =
      "Question crop " +
      (imageIndex + 1);

    img.src =
      "/api/crop/" +
      encodeURIComponent(
        q.id,
      ) +
      "/" +
      imageIndex;

    $("crops")
      .appendChild(
        img,
      );
  }

  $("cropStatus").textContent =
    q.crop.status +
    " · " +
    q.crop.flags.join("; ");

  $("occurrences").textContent =
    JSON.stringify(
      detail.occurrences,
      null,
      2,
    );

  $("sourceChoice")
    .replaceChildren();

  detail.occurrences.forEach(
    (occurrence, i) => {
      const option =
        document.createElement(
          "option",
        );

      option.value =
        String(i);

      option.textContent =
        (
          i +
          1 +
          " · " +
          (
            occurrence
              .metadata
              ?.title ??
            occurrence.source
          )
        );

      $("sourceChoice")
        .appendChild(
          option,
        );
    },
  );

  const occurrence =
    detail.occurrences[0] ??
    null;

  const metadata =
    occurrence?.metadata ??
    {};

  $("meta").innerHTML =
    [
      "<b>ID:</b> " +
        esc(q.id),

      "<b>Type:</b> " +
        esc(q.kind),

      "<b>Competition:</b> " +
        esc(
          metadata.competition ??
          "?",
        ),

      "<b>Edition:</b> " +
        esc(
          metadata.edition ??
          metadata.year ??
          "?",
        ),

      "<b>Level:</b> " +
        esc(
          metadata.level ??
          "?",
        ),

      "<b>Set:</b> " +
        esc(
          metadata.set ??
          "?",
        ),

      "<b>Section:</b> " +
        esc(
          q.section ||
          "?",
        ),

      "<b>Question:</b> #" +
        esc(q.number),

      "<b>Question page:</b> " +
        esc(
          q.questionPage,
        ),

      "<b>Solution page:</b> " +
        esc(
          q.solutionPage ??
          "?",
        ),
    ].join("<br>");

  $("question").textContent =
    q.text ||
    "(no extracted text)";

  $("answer").textContent =
    q.officialAnswer ||
    "(missing)";

  $("solution").textContent =
    q.officialSolution ||
    "(missing)";

  $("choices").innerHTML =
    "";

  for (
    const choice of
      q.choices ??
      []
  ) {
    const element =
      document.createElement(
        "div",
      );

    element.className =
      "choice";

    const label =
      document.createElement(
        "b",
      );

    label.textContent =
      choice.label +
      ". ";

    element.appendChild(
      label,
    );

    element.appendChild(
      document.createTextNode(
        choice.text,
      ),
    );

    $("choices")
      .appendChild(
        element,
      );
  }

  const flags =
    q.flags ??
    [];

  $("flagCard")
    .classList.toggle(
      "hidden",
      flags.length === 0,
    );

  $("flags").innerHTML =
    flags
      .map(
        (flag) =>
          '<span class="flag">' +
          esc(flag) +
          "</span>",
      )
      .join("");

  function sourcePreview(
    rebuild = false,
  ) {
    const chosen =
      Number(
        $("sourceChoice")
          .value ||
        0,
      );

    const current =
      detail.occurrences[
        chosen
      ];

    if (!current) {
      return;
    }

    if (rebuild) {
      $("sourcePageNumber")
        .replaceChildren();

      for (
        let page =
          current.payload
            .questionPage;
        page <=
          current.payload
            .questionEndPage;
        page++
      ) {
        const option =
          document.createElement(
            "option",
          );

        option.value =
          String(page);

        option.textContent =
          String(page);

        $("sourcePageNumber")
          .appendChild(
            option,
          );
      }
    }

    const page =
      Number(
        $("sourcePageNumber")
          .value,
      ) ||
      q.questionPage;

    $("sourcePage").src =
      "/api/source-page/" +
      encodeURIComponent(
        q.id,
      ) +
      "/" +
      chosen +
      "/" +
      page;

    $("sourcePage")
      .classList.remove(
        "hidden",
      );

    $("sourcePage").onerror =
      () =>
        $("sourcePage")
          .classList.add(
            "hidden",
          );

    $("sourceLink").href =
      "/api/source/" +
      encodeURIComponent(
        q.id,
      ) +
      "/" +
      chosen +
      "#page=" +
      page;

    $("solutionLink").href =
      "/api/source/" +
      encodeURIComponent(
        q.id,
      ) +
      "/" +
      chosen +
      "#page=" +
      (
        current
          ?.payload
          ?.solutionPage ??
        q.solutionPage ??
        1
      );
  }

  $("sourceChoice").onchange =
    () =>
      sourcePreview(
        true,
      );

  $("sourcePageNumber")
    .onchange =
    () =>
      sourcePreview();

  if (occurrence) {
    sourcePreview(true);

    $("sourceEmpty")
      .classList.add(
        "hidden",
      );
  } else {
    $("sourcePage")
      .classList.add(
        "hidden",
      );

    $("sourceEmpty")
      .classList.remove(
        "hidden",
      );
  }
}

async function review(
  newState,
) {
  if (
    !detail ||
    !currentClaimedId
  ) {
    return;
  }

  const id =
    detail.question.id;

  try {
    await api(
      "/api/review/" +
      encodeURIComponent(id),
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body:
          JSON.stringify({
            state:
              newState,

            acknowledgeSource:
              $("sourceReviewed")
                .checked,

            acknowledgeCrop:
              $("cropReviewed")
                .checked,
          }),
      },
    );

    currentClaimedId =
      null;

    if (claimRefreshTimer) {
      clearInterval(
        claimRefreshTimer,
      );

      claimRefreshTimer =
        null;
    }

    await refresh();
  } catch (error) {
    showError(error);
  }
}

async function next() {
  if (!items.length) {
    return;
  }

  await releaseCurrent();

  index =
    (
      index +
      1
    ) %
    items.length;

  await render();
}

async function prev() {
  if (!items.length) {
    return;
  }

  await releaseCurrent();

  index =
    (
      index -
      1 +
      items.length
    ) %
    items.length;

  await render();
}

$("replace").onclick =
  async () => {
    if (!detail) {
      return;
    }

    try {
      const form =
        new FormData();

      for (
        const file of
          $("images").files
      ) {
        form.append(
          "images",
          file,
        );
      }

      await api(
        "/api/replace/" +
        encodeURIComponent(
          detail.question.id,
        ),
        {
          method:
            "POST",

          body:
            form,
        },
      );

      await refresh(
        detail.question.id,
      );
    } catch (error) {
      showError(error);
    }
  };

$("approve").onclick =
  () =>
    review(
      "approved",
    );

$("reject").onclick =
  () =>
    review(
      "rejected",
    );

$("skip").onclick =
  () =>
    next();

$("next").onclick =
  () =>
    next();

$("prev").onclick =
  () =>
    prev();

$("state").onchange =
  async (event) => {
    await releaseCurrent();

    state =
      event.target.value;

    index =
      0;

    await refresh();
  };

$("reviewer").onchange =
  async (event) => {
    await releaseCurrent();

    const value =
      event.target.value;

    if (value) {
      localStorage.setItem(
        "qotd-reviewer",
        value,
      );
    } else {
      localStorage.removeItem(
        "qotd-reviewer",
      );
    }

    index =
      0;

    await refresh();
  };

document.addEventListener(
  "keydown",
  (event) => {
    if (
      event.target instanceof
        HTMLInputElement ||
      event.target instanceof
        HTMLTextAreaElement ||
      event.target instanceof
        HTMLSelectElement
    ) {
      return;
    }

    const key =
      event.key.toLowerCase();

    if (
      key === "a" &&
      state === "pending"
    ) {
      review(
        "approved",
      );
    }

    if (
      key === "r" &&
      state === "pending"
    ) {
      review(
        "rejected",
      );
    }

    if (
      key === "s" ||
      key === "j"
    ) {
      next();
    }

    if (key === "k") {
      prev();
    }

    if (
      event.key ===
      "ArrowRight"
    ) {
      next();
    }

    if (
      event.key ===
      "ArrowLeft"
    ) {
      prev();
    }
  },
);

window.addEventListener(
  "pagehide",
  () => {
    if (
      !currentClaimedId ||
      !reviewer()
    ) {
      return;
    }

    /*
     * keepalive gives the release request
     * a chance to finish while the tab closes.
     * If it doesn't, the 15-minute expiry
     * handles the abandoned claim.
     */
    fetch(
      "/api/release/" +
      encodeURIComponent(
        currentClaimedId,
      ),
      {
        method:
          "POST",

        keepalive:
          true,

        headers: {
          "X-Review-Token":
            reviewToken,

          "X-Reviewer":
            reviewer(),
        },
      },
    ).catch(
      () => {},
    );
  },
);

(async () => {
  try {
    await loadReviewers();
    await refresh();
  } catch (error) {
    showError(error);
  }
})();
</script>

</body>
</html>
`;

  const server = Bun.serve({
    hostname: host,
    port,

    maxRequestBodySize:
      81_000_000,

    async fetch(req) {
      const url =
        new URL(req.url);

      try {
        /*
         * Same-origin protection.
         *
         * We intentionally no longer require hostname ===
         * 127.0.0.1 because a private team deployment may
         * bind to a LAN/Tailscale address.
         */
        const origin =
          req.headers.get(
            'origin',
          );

        if (
          origin &&
          origin !== url.origin
        ) {
          return json(
            {
              error:
                'Foreign origin rejected',
            },
            403,
          );
        }

        if (
          req.method !== 'GET' &&
          req.headers.get(
            'x-review-token',
          ) !== token
        ) {
          return json(
            {
              error:
                'Review token required',
            },
            403,
          );
        }

        if (
          req.method === 'GET' &&
          url.pathname === '/'
        ) {
          return new Response(
            HTML.replace(
              '__REVIEW_TOKEN__',
              token,
            ),
            {
              headers: {
                'Content-Type':
                  'text/html; charset=utf-8',

                'Cache-Control':
                  'no-store',
              },
            },
          );
        }

        if (
          req.method === 'GET' &&
          url.pathname ===
            '/api/reviewers'
        ) {
          return json({
            reviewers,
          });
        }

        if (
          req.method === 'GET' &&
          url.pathname ===
            '/api/stats'
        ) {
          return json(
            store.reviewStats(),
          );
        }

        if (
          req.method === 'GET' &&
          url.pathname ===
            '/api/questions'
        ) {
          const state =
            url.searchParams.get(
              'state',
            ) ??
            'pending';

          if (
            state !== 'pending' &&
            state !== 'approved' &&
            state !== 'rejected'
          ) {
            return json(
              {
                error:
                  'Invalid state',
              },
              400,
            );
          }

          let questions =
            store.list(
              state,
              10_000,
            );

          /*
           * Pending queue hides active claims
           * owned by someone else.
           */
          if (
            state === 'pending'
          ) {
            const actor =
              reviewerFrom(req);

            const claims =
              new Map(
                store
                  .reviewClaims()
                  .map(
                    (claim) => [
                      claim.question,
                      claim,
                    ],
                  ),
              );

            questions =
              questions.filter(
                (question) => {
                  const claim =
                    claims.get(
                      question.id,
                    );

                  return (
                    !claim ||
                    claim.actor ===
                      actor
                  );
                },
              );
          }

          return json(
            questions,
          );
        }

        const questionMatch =
          url.pathname.match(
            /^\/api\/question\/([^/]+)$/,
          );

        if (
          req.method === 'GET' &&
          questionMatch
        ) {
          const id =
            decodeURIComponent(
              questionMatch[1]!,
            );

          const data =
            fullQuestion(id);

          if (!data) {
            return json(
              {
                error:
                  'Question not found',
              },
              404,
            );
          }

          return json(data);
        }

        const claimMatch =
          url.pathname.match(
            /^\/api\/claim\/([^/]+)$/,
          );

        if (
          req.method === 'POST' &&
          claimMatch
        ) {
          const actor =
            reviewerFrom(req);

          const id =
            decodeURIComponent(
              claimMatch[1]!,
            );

          const claim =
            store.claimForReview(
              id,
              actor,
              claimTtlMs,
            );

          return json({
            ok: true,
            claim,
          });
        }

        const refreshClaimMatch =
          url.pathname.match(
            /^\/api\/claim\/([^/]+)\/refresh$/,
          );

        if (
          req.method === 'POST' &&
          refreshClaimMatch
        ) {
          const actor =
            reviewerFrom(req);

          const id =
            decodeURIComponent(
              refreshClaimMatch[1]!,
            );

          const claim =
            store.refreshReviewClaim(
              id,
              actor,
              claimTtlMs,
            );

          return json({
            ok: true,
            claim,
          });
        }

        const releaseMatch =
          url.pathname.match(
            /^\/api\/release\/([^/]+)$/,
          );

        if (
          req.method === 'POST' &&
          releaseMatch
        ) {
          const actor =
            reviewerFrom(req);

          const id =
            decodeURIComponent(
              releaseMatch[1]!,
            );

          store.releaseReviewClaim(
            id,
            actor,
          );

          return json({
            ok: true,
          });
        }

        const sourceMatch =
          url.pathname.match(
            /^\/api\/source\/([^/]+)\/(\d+)$/,
          );

        if (
          req.method === 'GET' &&
          sourceMatch
        ) {
          const id =
            decodeURIComponent(
              sourceMatch[1]!,
            );

          const occurrenceIndex =
            Number(
              sourceMatch[2]!,
            );

          const occurrences =
            store.occurrences(id);

          const occurrence =
            occurrences[
              occurrenceIndex
            ];

          if (!occurrence) {
            return new Response(
              'Source not found',
              {
                status: 404,
              },
            );
          }

          const path =
            resolve(
              String(
                occurrence.asset,
              ),
            );

          if (
            !existsSync(path)
          ) {
            return new Response(
              'The source PDF is not available at:\n' +
                path,
              {
                status:
                  404,

                headers: {
                  'Content-Type':
                    'text/plain; charset=utf-8',
                },
              },
            );
          }

          return new Response(
            Bun.file(path),
            {
              headers: {
                'Content-Type':
                  'application/pdf',

                'Cache-Control':
                  'no-store',
              },
            },
          );
        }

        const pageMatch =
          url.pathname.match(
            /^\/api\/source-page\/([a-f0-9]{64})\/(\d+)\/(\d+)$/,
          );

        if (
          req.method === 'GET' &&
          pageMatch
        ) {
          const source =
            store.occurrences(
              pageMatch[1]!,
            )[
              Number(
                pageMatch[2]!,
              )
            ];

          if (!source) {
            return json(
              {
                error:
                  'Source not found',
              },
              404,
            );
          }

          const image =
            resolve(
              dirname(
                String(
                  source.asset,
                ),
              ),

              'rendered-pages',

              `page-${Number(
                pageMatch[3]!,
              )}.png`,
            );

          if (
            !existsSync(image)
          ) {
            return json(
              {
                error:
                  'Open the original PDF to inspect this page',
              },
              404,
            );
          }

          return new Response(
            Bun.file(image),
            {
              headers: {
                'Content-Type':
                  'image/png',

                'Cache-Control':
                  'no-store',
              },
            },
          );
        }

        const cropMatch =
          url.pathname.match(
            /^\/api\/crop\/([a-f0-9]{64})\/(\d+)$/,
          );

        if (
          req.method === 'GET' &&
          cropMatch
        ) {
          const crop =
            store.get(
              cropMatch[1]!,
            )?.crop.images[
              Number(
                cropMatch[2]!,
              )
            ];

          if (
            !crop ||
            !existsSync(
              crop.path,
            )
          ) {
            return json(
              {
                error:
                  'Crop unavailable',
              },
              404,
            );
          }

          return new Response(
            Bun.file(
              crop.path,
            ),
            {
              headers: {
                'Content-Type':
                  'image/png',

                'Cache-Control':
                  'no-store',
              },
            },
          );
        }

        const replaceMatch =
          url.pathname.match(
            /^\/api\/replace\/([a-f0-9]{64})$/,
          );

        if (
          req.method === 'POST' &&
          replaceMatch
        ) {
          const actor =
            reviewerFrom(req);

          const id =
            replaceMatch[1]!;

          const question =
            store.get(id);

          if (!question) {
            return json(
              {
                error:
                  'Question not found',
              },
              404,
            );
          }

          const form =
            await req.formData();

          const files =
            form.getAll(
              'images',
            );

          if (
            !files.length ||
            files.length > 10 ||
            files.some(
              (file) =>
                typeof file ===
                'string',
            )
          ) {
            return json(
              {
                error:
                  'Choose 1–10 question-only image files',
              },
              400,
            );
          }

          const inputs =
            await Promise.all(
              files.map(
                async (file) =>
                  new Uint8Array(
                    await (
                      file as File
                    ).arrayBuffer(),
                  ),
              ),
            );

          const directory =
            resolve(
              assets,
              'overrides',
            );

          mkdirSync(
            directory,
            {
              recursive: true,
            },
          );

          const crop =
            await overrideImages(
              inputs,
              realpathSync(
                directory,
              ),
            );

          store.replaceCrop(
            id,
            crop,
            actor,
            !legacyMode &&
              question.state ===
                'pending',
          );

          return json({
            ok: true,
          });
        }

        const reviewMatch =
          url.pathname.match(
            /^\/api\/review\/([^/]+)$/,
          );

        if (
          req.method === 'POST' &&
          reviewMatch
        ) {
          const actor =
            reviewerFrom(req);

          const id =
            decodeURIComponent(
              reviewMatch[1]!,
            );

          const question =
            store.get(id);

          if (!question) {
            return json(
              {
                error:
                  'Question not found',
              },
              404,
            );
          }

          const body =
            await req.json() as {
              state?: string;
              acknowledgeSource?: boolean;
              acknowledgeCrop?: boolean;
            };

          if (
            body.state !==
              'approved' &&
            body.state !==
              'rejected'
          ) {
            return json(
              {
                error:
                  'State must be approved or rejected',
              },
              400,
            );
          }

          store.review(
            id,
            body.state,
            actor,

            body
              .acknowledgeSource ===
              true,

            body
              .acknowledgeCrop ===
              true,

            !legacyMode,
          );

          return json({
            ok: true,
            id,
            state:
              body.state,
          });
        }

        return new Response(
          'Not found',
          {
            status: 404,
          },
        );
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          400,
        );
      }
    },
  });

  return server;
}