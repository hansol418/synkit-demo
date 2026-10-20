// synkit 체험 페이지: 브라우저 안에서 파이썬(Pyodide)으로 실제 synkit을 실행하고 결과를 그린다.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v === null || v === undefined ? "해당 없음" : (v * 100).toFixed(1) + "%");
const CLASS_KO = { mispredicted: "오추출", missed: "미검출", hallucinated: "환각", format_error: "형식 오류" };
const MIME = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
let runPipeline = null;

function show(v, unit) {
  if (v === null || v === undefined) return "<span class='small'>없음</span>";
  return esc(Array.isArray(v) ? v.join(", ") : v) + (unit ? " " + esc(unit) : "");
}

async function boot() {
  const say = (t) => ($("#status").textContent = t);
  const pyodide = await loadPyodide();
  say("필요한 라이브러리를 불러오는 중…");
  await pyodide.loadPackage(["pydantic", "pyyaml", "jinja2", "lxml", "micropip"]);
  await pyodide.pyimport("micropip").install(["openpyxl", "python-docx"]);
  say("synkit 코드를 불러오는 중…");
  const zip = await (await fetch("synkit.zip")).arrayBuffer();
  pyodide.unpackArchive(zip, "zip", { extractDir: "/pkg" });
  const extractor = await (await fetch("synkit_demo_extractor.py")).text();
  const glue = await (await fetch("glue.py")).text();
  pyodide.FS.writeFile("/pkg/synkit_demo_extractor.py", extractor);
  pyodide.FS.writeFile("/pkg/glue.py", glue);
  pyodide.runPython("import sys; sys.path.insert(0, '/pkg')");
  runPipeline = pyodide.pyimport("glue").run_pipeline;
  say("준비되었습니다. 실행을 눌러 보세요.");
  $("#run").disabled = false;
}

function params() {
  const f = (id) => $("#" + id).value;
  const n = (id) => Math.max(0, Math.min(10, parseInt(f(id) || "0", 10)));
  return {
    seed: parseInt(f("seed") || "7", 10), docs: parseInt(f("docs"), 10), unit_rate: f("unit_rate"), typo_rate: f("typo_rate"),
    missing_rate: f("missing_rate"), extractor: document.querySelector("input[name=extractor]:checked").value,
    inject: { mispredicted: n("n_mis"), missed: n("n_miss"), hallucinated: n("n_hal"), format_error: n("n_fmt") },
  };
}

function table(head, rows, numCols = []) {
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => "<tr>" + r.map((c, i) => `<td${numCols.includes(i) ? " class='num'" : ""}>${c}</td>`).join("") + "</tr>").join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderCards(r) {
  const g = r.grade.summary, c = r.check.summary, gap = r.grade.held_out_gap;
  const card = (k, v, s) => `<div class="card"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const errs = g.errors, total = errs.mispredicted + errs.missed + errs.hallucinated + errs.format_error;
  $("#cards").innerHTML =
    card("항목 정확도", pct(g.item_accuracy), `${g.items_correct}/${g.items_total}개 일치`) +
    card("문서 단위 완전 일치", pct(g.document_exact_rate), `${g.documents_exact}/${g.documents_total}건`) +
    card("오류", `${total}건`, `오추출 ${errs.mispredicted} · 미검출 ${errs.missed} · 환각 ${errs.hallucinated} · 형식 ${errs.format_error}`) +
    card("보류 양식 격차", gap ? gap.gap * 100 >= 0 ? (gap.gap * 100).toFixed(1) + "%p" : "0.0%p" : "해당 없음", gap ? `개발 ${pct(gap.development_accuracy)} − 보류 ${pct(gap.held_out_accuracy)}` : "") +
    card("점검", `<span class="${c.FAIL ? "bad" : c.WARN ? "warn" : "ok"}">${c.FAIL ? "실패" : c.WARN ? "경고" : "통과"}</span>`, `통과 ${c.PASS} · 경고 ${c.WARN} · 실패 ${c.FAIL} · 건너뜀 ${c.SKIP}`);
}

function renderInject(r) {
  const box = $("#inject_result");
  if (r.extractor.mode !== "inject") { box.innerHTML = ""; return; }
  const want = r.extractor.injected, got = r.grade.summary.errors;
  const rows = Object.keys(CLASS_KO).map((k) => [CLASS_KO[k], want[k], got[k], want[k] === got[k] ? "<span class='ok'>일치</span>" : "<span class='bad'>불일치</span>"]);
  box.innerHTML = "<h3>넣은 오류 vs 채점기가 찾은 오류</h3>" + table(["오류 유형", "일부러 넣은 개수", "채점기가 찾은 개수", "판정"], rows, [1, 2]) +
    "<p class='small'>넣으려 한 만큼 넣을 수 없는 경우(예: 누락 항목이 없어 환각을 못 만드는 경우)에는 실제로 넣은 개수가 기준입니다.</p>";
}

function renderDocView(r) {
  const v = r.doc_view, bad = new Set(r.grade.errors_detail.filter((e) => e.doc_id === v.doc_id).map((e) => e.requirement_id));
  $("#doc_title").textContent = `(${v.doc_id} · 양식 ${v.template})`;
  const rows = v.rows.map((x) => [
    `<code>${esc(x.id)}</code>`, show(x.truth, x.truth_unit),
    x.present ? show(x.shown, x.shown_unit) : "<span class='warn'>문서에서 빠짐(누락)</span>",
    x.variations.length ? esc(x.variations.join(", ")) : "<span class='small'>-</span>",
    show(x.got, x.got_unit), bad.has(x.id) ? "<span class='bad'>불일치</span>" : "<span class='ok'>일치</span>"]);
  $("#doc_view").innerHTML = table(["항목", "정답", "문서에 찍힌 모습", "변형", "추출 결과", "채점"], rows);
}

function renderResult(r) {
  renderCards(r); renderInject(r); renderDocView(r);
  $("#by_template").innerHTML = table(["양식", "구분", "항목 정확도", "문서 완전 일치", "오추출", "미검출", "환각", "형식 오류"],
    r.grade.by_template.map((t) => [esc(t.name), t.held_out ? "보류" : "개발", pct(t.item_accuracy), `${t.documents_exact}/${t.documents}`,
      t.errors.mispredicted, t.errors.missed, t.errors.hallucinated, t.errors.format_error]), [2, 3, 4, 5, 6, 7]);
  const issues = r.grade.issues;
  $("#issues_box").hidden = !issues.length;
  $("#issues").innerHTML = issues.slice(0, 12).map((i) => `<div class="err"><code>[${esc(i.code)}] ${esc(i.location)}</code><br>원인: ${esc(i.cause)}<br>힌트: ${esc(i.hint)}</div>`).join("") +
    (issues.length > 12 ? `<p class="small">… 외 ${issues.length - 12}건</p>` : "");
  $("#files").innerHTML = r.files.map((f) => {
    const ext = f.name.split(".").pop(), bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    return `<a href="${URL.createObjectURL(new Blob([bytes], { type: MIME[ext] }))}" download="${esc(f.name)}">${esc(f.name)}</a>`;
  }).join(" · ") + ` · 전체 ${r.generate.documents}건 중 양식별 대표 파일입니다. 첫 줄에 "합성 문서" 표시가 있습니다.`;
  $("#dataset").innerHTML = table(r.dataset.header, r.dataset.rows.map((row) => row.map(esc))) + `<p class="small">전체 ${r.dataset.total}행 중 앞 ${r.dataset.rows.length}행</p>`;
  $("#report_frame").srcdoc = r.report_html;
  $("#open_report").onclick = () => window.open(URL.createObjectURL(new Blob([r.report_html], { type: "text/html;charset=utf-8" })), "_blank");
  $("#result").hidden = false;
}

async function onRun(ev) {
  ev.preventDefault();
  const btn = $("#run"), err = $("#error");
  btn.disabled = true; err.hidden = true; $("#result").hidden = true; $("#progress").hidden = false;
  $("#steps").innerHTML = ""; $("#status").textContent = "실행 중… (브라우저 안에서 계산하므로 몇 초 걸립니다)";
  await new Promise((res) => setTimeout(res, 60)); // 화면이 먼저 갱신되게 한다
  try {
    const r = JSON.parse(runPipeline(JSON.stringify(params())));
    $("#steps").innerHTML = r.steps.map((s) => `<li><span class="ok">✓</span> ${esc(s.name)} <span class="secs">${s.seconds}초</span></li>`).join("");
    if (r.failed_at) {
      err.hidden = false;
      err.innerHTML = `<strong>${esc(r.failed_at)}에서 멈췄습니다.</strong>` + r.validate.errors.map((i) => `<p><code>[${esc(i.code)}] ${esc(i.location)}</code><br>원인: ${esc(i.cause)}<br>힌트: ${esc(i.hint)}</p>`).join("");
    } else {
      renderResult(r);
      $("#result").scrollIntoView({ behavior: "smooth" });
    }
    $("#status").textContent = "완료. 설정을 바꿔 다시 실행해 보세요.";
  } catch (e) {
    err.hidden = false; err.textContent = "실행 중 오류가 났습니다: " + e; $("#status").textContent = "오류";
  }
  btn.disabled = false;
}

for (const id of ["docs", "unit_rate", "typo_rate", "missing_rate"]) {
  $("#" + id).addEventListener("input", () => ($("#" + id + "_o").textContent = id === "docs" ? $("#" + id).value : Number($("#" + id).value).toFixed(2)));
}
for (const r of document.querySelectorAll("input[name=extractor]")) {
  r.addEventListener("change", () => $("#inject_box").classList.toggle("on", $("input[value=inject]").checked));
}
$("#form").addEventListener("submit", onRun);
boot().catch((e) => { $("#status").textContent = "엔진을 불러오지 못했습니다: " + e; });
