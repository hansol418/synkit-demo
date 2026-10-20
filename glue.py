"""브라우저(Pyodide)에서 synkit 파이프라인을 한 번에 돌리는 연결 코드.

실제 synkit 코드(schema, generate, render, grade, check, report)를 그대로 호출한다. 이 파일은 순서와 입출력만 맡는다.
모든 파일은 브라우저 메모리의 가상 폴더(/work)에만 생기고 서버로 나가지 않는다.
"""
import base64
import csv
import json
import shutil
import time
from pathlib import Path

import yaml

from synkit.check.service import run_checks
from synkit.constants import LIMITATION_NOTICE, SYNTHETIC_TAG
from synkit.generate.core import generate_dataset
from synkit.generate.variations import summarize_variations
from synkit.generate.writer import write_run
from synkit.grade.service import grade_run
from synkit.render.service import render_run
from synkit.report.service import make_report
from synkit.run_io import load_run
from synkit.schema.loader import load_schema_file
from synkit.schema.template import rfq_template_text
import synkit_demo_extractor as extractor

WORK = Path("/work")


def _issues(items):
    return [{"code": i.code, "location": i.location, "cause": i.cause, "hint": i.hint, "severity": i.severity} for i in items]


def _timed(steps, name, fn):
    start = time.time()
    value = fn()
    steps.append({"name": name, "seconds": round(time.time() - start, 2)})
    return value


def _schema_text(p):
    data = yaml.safe_load(rfq_template_text())
    data["seed"] = int(p["seed"])
    data["documents"]["count"] = int(p["docs"])
    variations = data["documents"]["variations"]
    variations["unit_notation_rate"] = float(p["unit_rate"])
    variations["typo_rate"] = float(p["typo_rate"])
    variations["missing_rate"] = float(p["missing_rate"])
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)


def _perfect(run_dir):
    truth = json.loads((run_dir / "ground_truth.json").read_text(encoding="utf-8"))
    meta = json.loads((run_dir / "run_meta.json").read_text(encoding="utf-8"))
    results = [{"doc_id": d["doc_id"], "requirements": [dict(r) for r in d["requirements"]],
                "compliance": [dict(c) for c in d.get("compliance", [])]} for d in truth["documents"]]
    return {"schema_version": "1", "run_id": meta["run_id"], "results": results}


def _inject(submission, want):
    """정답 제출에 알려진 개수의 오류를 넣는다. 넣을 수 없는 만큼은 실제로 넣은 개수에서 빠진다."""
    todo = dict(want)
    injected = {"mispredicted": 0, "missed": 0, "hallucinated": 0, "format_error": 0}
    for doc in submission["results"]:
        for r in doc["requirements"]:
            value, number = r.get("value"), isinstance(r.get("value"), (int, float)) and not isinstance(r.get("value"), bool)
            if value is None and todo["hallucinated"] > 0:
                r["value"], r["unit"] = 12, "V"; todo["hallucinated"] -= 1; injected["hallucinated"] += 1
            elif number and todo["mispredicted"] > 0:
                r["value"] = value + 77; todo["mispredicted"] -= 1; injected["mispredicted"] += 1
            elif number and todo["missed"] > 0:
                r["value"] = None; r.pop("unit", None); todo["missed"] -= 1; injected["missed"] += 1
            elif number and todo["format_error"] > 0:
                r.pop("unit", None); todo["format_error"] -= 1; injected["format_error"] += 1
    return injected


def _sample_files(run_dir):
    picked, out = {}, []
    for f in sorted((run_dir / "documents").glob("rfq_*")):
        if f.suffix not in picked:
            picked[f.suffix] = f
    for f in picked.values():
        out.append({"name": f.name, "b64": base64.b64encode(f.read_bytes()).decode("ascii")})
    return out


def _doc_view(run_dir, submission):
    """첫 문서의 정답, 문서에 찍힌 모습, 추출 결과를 나란히 보여 주는 표."""
    truth = json.loads((run_dir / "ground_truth.json").read_text(encoding="utf-8"))["documents"][0]
    plan = json.loads((run_dir / "document_plan.json").read_text(encoding="utf-8"))["documents"][0]
    got = {r["id"]: r for r in submission["results"][0]["requirements"]}
    shown = {i["id"]: i for i in plan["items"]}
    rows = []
    for r in truth["requirements"]:
        s, g = shown.get(r["id"], {}), got.get(r["id"], {})
        rows.append({"id": r["id"], "truth": r.get("value"), "truth_unit": r.get("unit"),
                     "shown": s.get("shown_value"), "shown_unit": s.get("shown_unit"), "present": s.get("present", True),
                     "variations": s.get("variations", []), "got": g.get("value"), "got_unit": g.get("unit")})
    return {"doc_id": truth["doc_id"], "template": truth["template"], "rows": rows}


def run_pipeline(params_json):
    p = json.loads(params_json)
    shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True)
    steps = []
    result = {"notice": LIMITATION_NOTICE, "tag": SYNTHETIC_TAG, "steps": steps}
    schema_path = WORK / "schema.yaml"
    text = _schema_text(p)
    schema_path.write_text(text, encoding="utf-8")

    loaded = _timed(steps, "스키마 검증", lambda: load_schema_file(schema_path))
    result["validate"] = {"ok": loaded.ok, "errors": _issues(loaded.errors), "warnings": _issues(loaded.warnings)}
    if not loaded.ok:
        result["failed_at"] = "스키마 검증"
        return json.dumps(result, ensure_ascii=False)

    def make():
        dataset = generate_dataset(loaded.schema, seed=None)
        return dataset, write_run(dataset, loaded.schema, text, WORK / "runs")

    dataset, run_info = _timed(steps, "합성 데이터 생성", make)
    result["generate"] = {"documents": len(dataset.documents), "models": len(dataset.models), "seed": dataset.seed,
                          "run_id": run_info.run_id, "variations": summarize_variations(dataset)}
    run_dir = run_info.path

    rendered = _timed(steps, "합성 문서 만들기", lambda: render_run(load_run(run_dir)))
    result["render"] = {"documents": rendered.documents, "by_template": rendered.by_template, "ok": rendered.ok,
                        "mismatches": rendered.l1_mismatches + rendered.l2_mismatches, "checked": rendered.l2_checked}

    mode = p["extractor"]
    injected = None
    if mode == "baseline":
        submission = _timed(steps, "문서 읽어 추출(간이 추출기)", lambda: extractor.extract_run(run_dir))
    else:
        submission = _perfect(run_dir)
        if mode == "inject":
            injected = _inject(submission, p["inject"])
        steps.append({"name": "추출 결과 준비(" + ("정답 그대로" if mode == "perfect" else "일부러 틀리게") + ")", "seconds": 0})
    result["extractor"] = {"mode": mode, "injected": injected}
    submission_path = WORK / "results.json"
    submission_path.write_text(json.dumps(submission, ensure_ascii=False), encoding="utf-8")

    graded = _timed(steps, "정답과 대조해 채점", lambda: grade_run(load_run(run_dir), submission_path, name=mode)).to_dict()
    result["grade"] = graded
    checked = _timed(steps, "현실성·안전성 점검", lambda: run_checks(load_run(run_dir)))
    result["check"] = json.loads((run_dir / "check_result.json").read_text(encoding="utf-8"))
    _timed(steps, "리포트 만들기", lambda: make_report(load_run(run_dir)))
    result["report_html"] = (run_dir / "report.html").read_text(encoding="utf-8")

    with open(run_dir / "dataset.csv", encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.reader(fh))
    result["dataset"] = {"header": rows[0], "rows": rows[1:13], "total": len(rows) - 1}
    result["doc_view"] = _doc_view(run_dir, submission)
    result["files"] = _sample_files(run_dir)
    return json.dumps(result, ensure_ascii=False)
