"""Exercise console → actual reply API over HTTP, with disposable databases and no agent."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import runpy
import secrets
import sqlite3
import tempfile
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request

support = runpy.run_path(str(Path(__file__).with_name("acceptance-smoke.py")))
Services, require, HTTP = support["Services"], support["require"], support["HTTP"]


def exercise(run_dir, checks, ready=None):
    services = Services(run_dir)
    token = secrets.token_hex(32)
    services.env.update(REA_PROFILE_TOKEN=token, FLOW_PROFILE_TOKEN=token, REA_BRAIN_URL=services.python_url,
                        REA_SEED_FIXTURES="0")
    try:
        services.start("node")
        services.env.update(FLOW_PROFILE_URL=services.node_url + "/api/v1/agent/profile",
                            FLOW_JOBS_URL=services.node_url + "/api/v1/agent/jobs",
                            FLOW_CITIES_URL=services.node_url + "/api/v1/agent/cities",
                            FLOW_CONFIG_URL=services.node_url + "/api/v1/bridge/devices/{device_code}/config")
        services.start("python")
        def req(base, path, data=None, auth=None, method=None, status=200):
            require(base.startswith("http://127.0.0.1:"), "Only loopback permitted")
            request = Request(base + path, data=None if data is None else json.dumps(data).encode(),
                              method=method, headers={**({"Content-Type": "application/json"} if data is not None else {}), **(auth or {})})
            try:
                result = HTTP.open(request, timeout=25)
            except HTTPError as error:
                result = error
            with result:
                body = json.loads(result.read())
                require(result.code == status, f"{request.get_method()} {path}: HTTP {result.code}, expected {status}; "
                        + (json.dumps(body, ensure_ascii=False) if "/kb-publish/" in path else ""))
            return body
        n, p = services.node_url, services.python_url
        credentials = {"username": "local-admin", "password": services.password}
        na = {"Authorization": "Bearer " + req(n, "/api/v1/auth/login", credentials)["access_token"]}
        pa = {"Authorization": "Bearer " + req(p, "/api/v1/auth/login", credentials)["access_token"]}
        def passed(name):
            checks.append({"name": name, "status": "passed"})
            print("PASS " + name, flush=True)
        # All rows are synthetic, in the temporary Node database created above.
        for row in req(n, "/api/v1/kb-faqs?page_size=1000", auth=na)["items"]:
            req(n, "/api/v1/kb-faqs/" + str(row["id"]), auth=na, method="DELETE")
        category = next(v for v in req(n, "/api/v1/verticals", auth=na)["items"] if v["code"] == "subway")
        wage = req(n, "/api/v1/kb-faqs", {"question": "工资多少", "keywords": ["工资"], "answer": "工资：{wage}",
                   "scope_level": "global", "vertical_id": category["id"]}, na, status=201)
        welfare = req(n, "/api/v1/kb-faqs", {"question": "包吃住吗", "keywords": ["包吃住"], "answer": "{welfare}",
                      "scope_level": "global", "vertical_id": category["id"]}, na, status=201)
        address = req(n, "/api/v1/kb-faqs", {"question": "在哪里面试", "keywords": ["面试地址"], "answer": "{address}",
                      "scope_level": "global", "vertical_id": category["id"]}, na, status=201)
        cert = req(n, "/api/v1/kb-faqs", {"question": "面试要带什么", "keywords": ["面试要带", "材料"], "answer": "{cert}",
                   "scope_level": "global", "vertical_id": category["id"]}, na, status=201)
        def preview():
            return req(n, "/api/v1/kb-publish/preview", {}, na)
        def apply(plan, status=200):
            return req(n, "/api/v1/kb-publish/apply", {"preview_id": plan["preview_id"]}, na, status=status)
        plan = preview()
        require(plan["target_id"] == req(p, "/api/v1/instance")["install_id"], "Wrong target instance")
        require(not req(p, "/api/v1/kb/governance/audit", auth=pa)["faq_inventory"], "Preview wrote target FAQ data")
        first = apply(plan)
        require(apply(plan)["replayed"], "Duplicate apply was not idempotent")
        audit = req(p, "/api/v1/kb/governance/audit", auth=pa)
        require(len(audit["faq_inventory"]) == len(plan["items"]), "Target read-back count differs")
        passed("preview-identity-apply-and-idempotent-readback")
        # Seed only disposable flow history to simulate clients' already-confirmed job snapshots.
        # No contact, bridge command, agent process, or production endpoint is used.
        def ask(key, text, factory, wage_text=None, place="本岗面试地址"):
            job = {"position_id": 991, "employer_id": 9, "location_id": 31,
                   "vertical_code": "subway", "factory_name": factory, "place": place, "cert_text": "本岗身份证与照片"}
            if wage_text is not None:
                job["wage_text"] = wage_text
            slots = {"city": "验收城市", "position_id": 991, "employer_id": 9, "location_id": 31,
                     "job_snapshot": job, "interview_offer_sent": True}
            with sqlite3.connect(run_dir / "python.sqlite") as db:
                events = [("stage_change", {"to": "ask_interview"}),
                          *(("slot_set", {"key": k, "value": v}) for k, v in slots.items())]
                db.executemany("INSERT INTO flow_events(session_key,seq,type,body,created_at) VALUES(?,?,?,?,?)",
                               [(key, i + 1, typ, json.dumps(value), datetime.now(timezone.utc).isoformat())
                                for i, (typ, value) in enumerate(events)])
            return req(p, "/api/v1/flow/answer", {"session_key": key, "text": text, "device_code": "isolated-acceptance"}, pa)["reply"]
        a = ask("kb-chen", "工资多少", "甲厂", "甲厂220/天")
        b = ask("kb-zhu", "工资多少", "乙厂", "乙厂210/天")
        require("甲厂220/天" in a and "乙厂" not in a, "First job borrowed another job's facts")
        require("乙厂210/天" in b and "甲厂" not in b, "Second job borrowed another job's facts")
        passed("published-template-renders-each-selected-job")
        missing = ask("kb-empty", "包吃住吗", "缺字段工厂")
        require("{" not in missing and "住宿免费" not in missing and "包吃包住" not in missing, "Missing facts invented a promise")
        require("本岗面试地址" in ask("kb-address", "面试地址在哪里", "本岗工厂"), "Address did not use selected job")
        passed("missing-field-and-selected-job-address")
        stale = preview()
        req(n, f"/api/v1/kb-faqs/{cert['id']}", {"answer": "证件要求：{cert_text}"}, na, "PUT")
        apply(stale, 409)
        updated = apply(preview())
        require("证件要求：本岗身份证与照片" in ask("kb-update", "面试要带什么", "甲厂"), "Edited template did not reach runtime")
        passed("source-conflict-and-edited-template-runtime")
        req(n, f"/api/v1/kb-faqs/{cert['id']}", {"status": "disabled"}, na, "PUT")
        stopped = apply(preview())
        target = req(p, "/api/v1/kb/governance/audit", auth=pa)["faq_inventory"]
        require(next(row for row in target if row["answer"] == "证件要求：{cert_text}")["status"] == "disabled", "Disabled FAQ remained active")
        require("证件要求：本岗身份证与照片" not in ask("kb-disabled", "面试要带什么", "甲厂"), "Disabled template still answered")
        rollback = req(n, "/api/v1/kb-publish/preview", {"rollback_of": stopped["publication_id"]}, na)
        apply(rollback)
        require("证件要求：本岗身份证与照片" in ask("kb-rollback", "面试要带什么", "甲厂"), "Rollback did not restore runtime template")
        passed("disable-and-audited-rollback-runtime")
        history = req(n, "/api/v1/kb-publish/history", auth=na)
        require(len(history["items"]) == 4, "Unexpected publication history")
        # Console save → device config → actual reply service, without a customer message.
        welcome_parts = ["你好，欢迎咨询招聘岗位。", "我先帮你了解一下。", "请问你现在在哪个城市？"]
        welcome_content = "\n---\n".join(welcome_parts)
        saved = req(n, "/api/v1/position-scripts", {"position_id": 0, "stage": "greet", "title": "临时测试欢迎语", "content": welcome_content}, na)
        reread = req(n, "/api/v1/position-scripts?position_id=0", auth=na)["items"]
        require(len(reread) == 1 and reread[0]["content"] == welcome_content, "Welcome save/readback mismatch")
        req(n, "/api/v1/agent/devices", {"device_code": "isolated-welcome", "device_name": "隔离欢迎语测试", "vertical_id": category["id"]}, na)
        cfg = req(n, "/api/v1/bridge/devices/isolated-welcome/config", auth={"X-Profile-Token": token})
        require(any(row["position_id"] == 0 and row["content"] == welcome_content for row in cfg["position_scripts"]), "Welcome not distributed")
        greeting = req(p, "/api/v1/flow/greet", {"session_key": "isolated-welcome-session", "device_code": "isolated-welcome"}, pa)
        require(greeting["parts"] == welcome_parts and not greeting["skipped"], "Runtime did not use configured welcome parts")
        state = req(p, "/api/v1/flow/state?session_key=isolated-welcome-session", auth=pa)
        require(state["turns"] == 0 and state["slots"]["scripted_sent"]["greet"], "Welcome fabricated a customer message or lost bookkeeping")
        disabled = req(n, "/api/v1/position-scripts", {"position_id": 0, "stage": "greet", "content": welcome_content, "status": "disabled"}, na)
        require(disabled["id"] == saved["id"], "Welcome update inserted duplicate row")
        require(not any(row["position_id"] == 0 for row in req(n, "/api/v1/bridge/devices/isolated-welcome/config", auth={"X-Profile-Token": token})["position_scripts"]), "Disabled welcome still distributed")
        passed("configured-welcome-save-device-runtime-parts-and-disable")
        # Each account has its own fixed recruitment introduction; general/position
        # greetings cannot override it. No real device process exists in this harness.
        intro_parts = ["工作内容：测试岗位说明", "工作时间：测试排班", "岗位福利与面试要求：测试说明"]
        intro = req(n, "/api/v1/agent/device-scripts", {"device_code": "isolated-welcome", "stage": "greet", "content": "\n---\n".join(intro_parts)}, na)
        req(n, "/api/v1/agent/devices", {"device_code": "isolated-other-intro", "device_name": "另一企微测试号", "vertical_id": category["id"]}, na)
        other_parts = ["另一账号的工作介绍", "另一账号的面试要求"]
        req(n, "/api/v1/agent/device-scripts", {"device_code": "isolated-other-intro", "stage": "greet", "content": "\n---\n".join(other_parts)}, na)
        first = req(p, "/api/v1/flow/greet", {"session_key": "isolated-device-intro", "device_code": "isolated-other-intro"}, pa)
        require(first["parts"] == other_parts, "Device introduction leaked across accounts or lost message order")
        # isolated-welcome was cached earlier without greet. A fresh second device
        # exercises runtime delivery; config readback checks the edited first device.
        cfg = req(n, "/api/v1/bridge/devices/isolated-welcome/config", auth={"X-Profile-Token": token})
        require(next(row for row in cfg["scripts"] if row["stage"] == "greet")["content"] == "\n---\n".join(intro_parts), "Device intro not distributed")
        reread = req(n, "/api/v1/agent/device-scripts?device_code=isolated-welcome&stage=greet", auth=na)["items"]
        require(len(reread) == 1 and reread[0]["id"] == intro["id"], "Per-device intro readback mismatch")
        stopped_intro = req(n, "/api/v1/agent/device-scripts", {"device_code": "isolated-welcome", "stage": "greet", "content": "\n---\n".join(intro_parts), "status": "disabled"}, na)
        require(stopped_intro["id"] == intro["id"], "Device intro update inserted duplicate row")
        require(not any(row["stage"] == "greet" for row in req(n, "/api/v1/bridge/devices/isolated-welcome/config", auth={"X-Profile-Token": token})["scripts"]), "Disabled device intro distributed")
        passed("per-account-recruitment-intro-isolation-readback-and-disable")
        if ready:
            ready({"node_url": n, "python_url": p, "username": "local-admin", "password": services.password})
    finally:
        services.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    result = {"mode": "isolated-http-no-agent", "checks": [], "status": "failed"}
    try:
        with tempfile.TemporaryDirectory(prefix="kb-publication-", ignore_cleanup_errors=True) as directory:
            exercise(Path(directory), result["checks"])
        result["status"] = "passed"
    except Exception as error:
        result["error"] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print("FAIL " + result["error"], flush=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"KB publication {result['status']}: {len(result['checks'])} scenarios; no agent")
    return result["status"] != "passed"


if __name__ == "__main__":
    raise SystemExit(main())
