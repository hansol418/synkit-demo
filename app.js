// synkit 체험 페이지: 브라우저 안에서 파이썬(Pyodide)으로 실제 synkit을 실행한다. 그리는 일은 render.js가 맡는다.
let runPipeline = null;
const BUTTONS = ["#demo1", "#demo2", "#run"];
const setButtons = (disabled) => BUTTONS.forEach((b) => ($(b).disabled = disabled));

async function boot() {
  const say = (t) => ($("#status").textContent = t);
  const pyodide = await loadPyodide();
  say("필요한 라이브러리를 불러오는 중…");
  await pyodide.loadPackage(["pydantic", "pyyaml", "jinja2", "lxml", "micropip"]);
  await pyodide.pyimport("micropip").install(["openpyxl", "python-docx"]);
  say("synkit 코드를 불러오는 중…");
  pyodide.unpackArchive(await (await fetch("synkit.zip")).arrayBuffer(), "zip", { extractDir: "/pkg" });
  for (const name of ["synkit_demo_extractor.py", "glue.py"]) pyodide.FS.writeFile("/pkg/" + name, await (await fetch(name)).text());
  pyodide.runPython("import sys; sys.path.insert(0, '/pkg')");
  runPipeline = pyodide.pyimport("glue").run_pipeline;
  $("#dot").classList.add("ready");
  say("준비되었습니다. 위의 버튼을 눌러 보세요.");
  setButtons(false);
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

function preset(kind) {
  const set = { seed: 7, docs: 30, unit_rate: 0.3, typo_rate: 0.02, missing_rate: 0.03, n_mis: 2, n_miss: 1, n_hal: 1, n_fmt: 1 };
  for (const [id, v] of Object.entries(set)) { $("#" + id).value = v; $("#" + id).dispatchEvent(new Event("input")); }
  document.querySelector(`input[value=${kind === "inject" ? "inject" : "baseline"}]`).click();
}

async function run() {
  const err = $("#error");
  setButtons(true); err.hidden = true; $("#result").hidden = true; $("#progress").hidden = true;
  $("#status").textContent = "실행 중… (브라우저 안에서 계산하므로 몇 초 걸립니다)";
  await new Promise((res) => setTimeout(res, 60)); // 화면이 먼저 갱신되게 한다
  try {
    const r = JSON.parse(runPipeline(JSON.stringify(params())));
    if (r.failed_at) {
      err.hidden = false;
      err.innerHTML = `<strong>${esc(r.failed_at)}에서 멈췄습니다.</strong>` + r.validate.errors.map((i) => `<p><code>[${esc(i.code)}] ${esc(i.location)}</code><br>원인: ${esc(i.cause)}<br>힌트: ${esc(i.hint)}</p>`).join("");
    } else {
      renderResult(r);
      $("#progress").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth" });
    }
    $("#status").textContent = "완료. 다른 버튼이나 설정으로 다시 실행해 보세요.";
  } catch (e) {
    err.hidden = false; err.textContent = "실행 중 오류가 났습니다: " + e; $("#status").textContent = "오류";
  }
  setButtons(false);
}

for (const id of ["docs", "unit_rate", "typo_rate", "missing_rate"]) {
  $("#" + id).addEventListener("input", () => ($("#" + id + "_o").textContent = id === "docs" ? $("#" + id).value : Number($("#" + id).value).toFixed(2)));
}
for (const r of document.querySelectorAll("input[name=extractor]")) {
  r.addEventListener("change", () => $("#inject_box").classList.toggle("on", $("input[value=inject]").checked));
}
$("#demo1").addEventListener("click", () => { preset("baseline"); run(); });
$("#demo2").addEventListener("click", () => { preset("inject"); run(); });
$("#form").addEventListener("submit", (ev) => { ev.preventDefault(); run(); });
boot().catch((e) => { $("#status").textContent = "엔진을 불러오지 못했습니다: " + e; });
