// 결과 그리기. 계산은 하지 않고 synkit이 낸 값(r)을 고르고 보기 좋게 바꾸기만 한다.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => (v === null || v === undefined ? "해당 없음" : (v * 100).toFixed(1) + "%");
const CLASS_KO = { mispredicted: "오추출", missed: "미검출", hallucinated: "환각", format_error: "형식 오류" };
const MIME = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sum = (o) => Object.keys(CLASS_KO).reduce((n, k) => n + (o[k] || 0), 0);

function show(v, unit) {
  if (v === null || v === undefined) return "<span class='small'>없음</span>";
  return esc(Array.isArray(v) ? v.join(", ") : v) + (unit ? " " + esc(unit) : "");
}

function table(head, rows, numCols = []) {
  const th = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((r) => "<tr>" + r.map((c, i) => `<td${numCols.includes(i) ? " class='num'" : ""}>${c}</td>`).join("") + "</tr>").join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

function countUp(el, target, text) {
  if (REDUCED) { el.textContent = text(target); return; }
  const t0 = performance.now(), ms = 1000;
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / ms), eased = 1 - Math.pow(1 - k, 3);
    el.textContent = text(target * eased);
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function summarySentence(r) {
  const g = r.grade.summary, wrong = g.items_total - g.items_correct;
  if (r.extractor.mode === "inject") {
    const want = r.extractor.injected, same = Object.keys(CLASS_KO).every((k) => want[k] === g.errors[k]);
    return `일부러 넣은 오류 ${sum(want)}개를 채점기가 ${sum(g.errors)}개 찾았고, 종류별 개수도 ${same ? "모두 일치합니다" : "일치하지 않는 것이 있습니다"}.`;
  }
  let s = `문서 ${r.generate.documents}건, 항목 ${g.items_total}개 중 ${g.items_correct}개를 맞혔습니다.`;
  if (wrong === 0) return s + " 틀린 항목이 없습니다.";
  const bad = r.grade.by_template.filter((t) => sum(t.errors) > 0);
  const held = bad.some((t) => t.held_out), dev = bad.some((t) => !t.held_out);
  s += ` 틀린 ${wrong}개는 ` + (held && !dev ? "개발에 쓰지 않은 처음 보는 양식에서만 나왔습니다." : dev && !held ? "개발에 쓴 양식에서 나왔습니다." : "여러 양식에서 나왔습니다.");
  const gap = r.grade.held_out_gap;
  return gap && gap.gap > 0 ? s + ` 개발 양식은 ${pct(gap.development_accuracy)}, 처음 보는 양식은 ${pct(gap.held_out_accuracy)}입니다.` : s;
}

function renderRing(acc) {
  const fg = $("#ring_fg"), full = 326.73;
  fg.style.strokeDashoffset = full;
  requestAnimationFrame(() => requestAnimationFrame(() => (fg.style.strokeDashoffset = full * (1 - acc))));
  countUp($("#ring_num"), acc * 100, (v) => v.toFixed(1) + "%");
  $(".ring").setAttribute("aria-label", `항목 정확도 ${pct(acc)}`);
}

function renderTiles(r) {
  const g = r.grade.summary, c = r.check.summary, e = g.errors, gap = r.grade.held_out_gap;
  const tile = (k, v, s) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  $("#tiles").innerHTML =
    tile("문서 단위 완전 일치", pct(g.document_exact_rate), `${g.documents_exact}/${g.documents_total}건`) +
    tile("오류", `${sum(e)}건`, `오추출 ${e.mispredicted} · 미검출 ${e.missed} · 환각 ${e.hallucinated} · 형식 ${e.format_error}`) +
    tile("보류 양식 격차", gap ? (gap.gap * 100).toFixed(1) + "%p" : "해당 없음", gap ? `개발 ${pct(gap.development_accuracy)} − 보류 ${pct(gap.held_out_accuracy)}` : "") +
    tile("점검", `<span class="${c.FAIL ? "bad" : c.WARN ? "warn" : "ok"}">${c.FAIL ? "✗ 실패" : c.WARN ? "! 경고" : "✓ 통과"}</span>`, `통과 ${c.PASS} · 경고 ${c.WARN} · 실패 ${c.FAIL} · 건너뜀 ${c.SKIP}`);
}

function renderInject(r) {
  const box = $("#inject_result");
  if (r.extractor.mode !== "inject") { box.innerHTML = ""; return; }
  const want = r.extractor.injected, got = r.grade.summary.errors, keys = Object.keys(CLASS_KO);
  const same = keys.every((k) => want[k] === got[k]);
  const marks = (n) => `<span class="marks" aria-hidden="true">${"●".repeat(Math.min(n, 10)) || "-"}</span> <span>${n}개</span>`;
  const rows = keys.map((k) => `<div class="row"><span>${CLASS_KO[k]}</span><span>${marks(want[k])}</span><span>${marks(got[k])}</span>` +
    `<span class="match ${want[k] === got[k] ? "good" : "badtxt"}">${want[k] === got[k] ? "✓ 일치" : "✗ 불일치"}</span></div>`).join("");
  box.innerHTML = `<h3>채점기를 믿어도 되는가?</h3><div class="board"><p class="verdict">넣은 오류 ${sum(want)}개 → 찾은 오류 ${sum(got)}개 · ` +
    `<span class="${same ? "good" : "badtxt"}">${same ? "✓ 전부 일치" : "✗ 불일치 있음"}</span></p>` +
    `<div class="row hd"><span>오류 종류</span><span>일부러 넣은 것</span><span>채점기가 찾은 것</span><span>판정</span></div>${rows}</div>` +
    "<p class='small'>넣으려 한 만큼 넣을 수 없는 경우(예: 누락 항목이 없어 환각을 못 만드는 경우)에는 실제로 넣은 개수가 기준입니다.</p>";
}

function renderBars(r) {
  $("#by_template").innerHTML = r.grade.by_template.map((t) => {
    const label = `${esc(t.name)} · ${t.held_out ? "보류(처음 보는 양식)" : "개발"}`;
    return `<div class="bar" role="img" aria-label="${label} ${pct(t.item_accuracy)}"><div class="lab"><span>${label}</span><span>${pct(t.item_accuracy)}</span></div>` +
      `<div class="track"><div class="fill${t.held_out ? " held" : ""}" data-w="${t.item_accuracy * 100}"></div></div></div>`;
  }).join("");
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelectorAll(".fill").forEach((f) => (f.style.width = f.dataset.w + "%"))));
  const gap = r.grade.held_out_gap;
  $("#gap_note").textContent = gap ? `개발 양식 ${pct(gap.development_accuracy)} − 보류 양식 ${pct(gap.held_out_accuracy)} = ${(gap.gap * 100).toFixed(1)}%p. 개발에 맞춰 튜닝했는지를 보는 지표이며 실제 문서에서의 성능이 아닙니다.` : "";
}

function renderDocView(r) {
  const v = r.doc_view, bad = new Set(r.grade.errors_detail.filter((e) => e.doc_id === v.doc_id).map((e) => e.requirement_id));
  $("#doc_title").textContent = `(${v.doc_id} · 양식 ${v.template})`;
  $("#doc_view").innerHTML = table(["항목", "① 정답", "② 문서에 찍힌 모습", "변형", "③ 추출 결과", "채점"], v.rows.map((x) => [
    `<code>${esc(x.id)}</code>`, show(x.truth, x.truth_unit),
    x.present ? show(x.shown, x.shown_unit) : "<span class='warn'>문서에서 빠짐(누락)</span>",
    x.variations.length ? esc(x.variations.join(", ")) : "<span class='small'>-</span>",
    show(x.got, x.got_unit), bad.has(x.id) ? "<span class='bad'>✗ 불일치</span>" : "<span class='ok'>✓ 일치</span>"]));
}

function renderDetails(r) {
  const issues = r.grade.issues;
  $("#issues_box").hidden = !issues.length;
  $("#issues").innerHTML = issues.slice(0, 12).map((i) => `<div class="err"><code>[${esc(i.code)}] ${esc(i.location)}</code><br>원인: ${esc(i.cause)}<br>힌트: ${esc(i.hint)}</div>`).join("") +
    (issues.length > 12 ? `<p class="small">… 외 ${issues.length - 12}건</p>` : "");
  $("#files").innerHTML = r.files.map((f) => {
    const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
    return `<a href="${URL.createObjectURL(new Blob([bytes], { type: MIME[f.name.split(".").pop()] }))}" download="${esc(f.name)}">${esc(f.name)}</a>`;
  }).join(" · ") + ` · 전체 ${r.generate.documents}건 중 양식별 대표 파일입니다. 첫 줄에 "합성 문서" 표시가 있습니다.`;
  $("#dataset").innerHTML = table(r.dataset.header, r.dataset.rows.map((row) => row.map(esc))) + `<p class="small">전체 ${r.dataset.total}행 중 앞 ${r.dataset.rows.length}행</p>`;
  $("#report_frame").srcdoc = r.report_html;
  $("#open_report").onclick = () => window.open(URL.createObjectURL(new Blob([r.report_html], { type: "text/html;charset=utf-8" })), "_blank");
}

function renderResult(r) {
  $("#summary").textContent = summarySentence(r);
  renderRing(r.grade.summary.item_accuracy); renderTiles(r); renderInject(r); renderBars(r); renderDocView(r); renderDetails(r);
  $("#steps").innerHTML = r.steps.map((s, i) => `<li style="--i:${i}"><span class="ck" aria-hidden="true">✓</span>${esc(s.name)} <span class="sec">${s.seconds}초</span></li>`).join("");
  $("#progress").hidden = false; $("#result").hidden = false;
}
