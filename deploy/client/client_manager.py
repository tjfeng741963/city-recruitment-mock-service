"""Windows client management window; opening it never starts automatic replies."""

from __future__ import annotations

import os
from pathlib import Path
import queue
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

import client_updater as updater
from client_manager_service import ManagerService


BACKGROUND = "#f2f5fa"
INK = "#192940"
MUTED = "#5d6c80"
BLUE = "#235bd8"


def friendly_error(exc: Exception) -> str:
    text = str(exc)
    if any(word in text for word in ("HTTPS", "GitHub", "HTTP", "urlopen", "timed out")):
        return f"{text}。可以重试，或导入已下载的官方更新包。"
    if "another client updater" in text:
        return "另一个更新或启动操作正在进行，请稍后刷新状态。"
    if "manager protocol" in text:
        return "该发布包不支持当前管理窗口，已阻止覆盖。请等待兼容版本发布或联系维护人员。"
    if "frozen" in text:
        return "核心文件与已核准版本不符，操作已停止。请保留日志并联系维护人员。"
    if "checksum" in text or "hash mismatch" in text:
        return "更新包校验失败，未安装该包。请重新检查更新。"
    if "rollback incomplete" in text:
        return "更新失败，部分文件未能恢复。请保持自动回复停止，并将详细信息交给维护人员。"
    if "rolled back" in text:
        return "更新未完成，已恢复替换前的文件。自动回复未启动，请查看详细信息。"
    return text or type(exc).__name__


def _reply_mode_ready(mode: dict | None) -> bool:
    return bool(mode and mode.get("ready") and time.time() - (mode.get("local_at") or 0) <= 20)


def _recipient_verification_blocked(mode: dict | None) -> bool:
    return bool(mode and mode.get("send_issue") == "recipient_verification")


def reply_mode_text(state: dict | None, now: float | None = None) -> str:
    if not state or not state.get("running"):
        return ""
    mode = state.get("reply_mode")
    if not mode:
        return "正在确认回复来源"
    now = time.time() if now is None else now
    names = {"agent": "系统 Agent", "dify": "Dify"}
    effective = names.get(mode.get("effective"), "待确认")
    target = names.get(mode.get("target"), "待确认")
    stage = mode.get("phase")
    elapsed = max(0, int((mode.get("elapsed_seconds") or 0) + now - (mode.get("local_at") or now)))
    age = f"{elapsed // 60} 分 {elapsed % 60} 秒" if elapsed >= 60 else f"{elapsed} 秒"
    if now - (mode.get("local_at") or 0) > 20:
        return f"上次确认 {effective} · 状态暂未更新"
    if stage in {"waiting", "applying"}:
        if mode.get("local_issue") in {"network", "auth"}:
            detail = "设备鉴权失败，请检查配对" if mode.get("local_issue") == "auth" else "等待网络恢复"
        else:
            reasons = {
                "wechat": "等待企业微信登录",
                "receipt": "等待发送回执",
                "local_state": "核对本地发送记录",
                "configuration": "配置未匹配，正在重试",
                "desktop": "等待 Windows 桌面",
            }
            detail = reasons.get(mode.get("local_issue") or mode.get("issue")) or (
                "正在应用配置" if stage == "applying" else "等待当前任务结束"
            )
        action = "恢复" if mode.get("rollback") else "切换"
        return f"{effective} → {target} · {action}中 · {detail} · 已等待 {age}"
    if not mode.get("ready"):
        detail = "设备鉴权失败，请检查配对" if mode.get("local_issue") == "auth" else "等待网络、配置或企微就绪"
        return f"上次确认 {effective} · {detail}"
    suffix = " · 已切换" if stage == "completed" else " · 已恢复" if stage == "cancelled" else ""
    return f"正在使用 {effective}{suffix}"


class ManagerWindow:
    def __init__(self, window: tk.Tk, service: ManagerService):
        self.window = window
        self.service = service
        self.busy = False
        self.operation = None
        self.closed = False
        self.release = None
        self.state = None
        self.events = queue.SimpleQueue()
        self.watch_pending = False
        self.status_generation = 0
        self.next_inventory = time.monotonic() + 20
        self.current_text = tk.StringVar(value="读取中…")
        self.latest_text = tk.StringVar(value="点击「检查更新」获取")
        self.runtime_text = tk.StringVar(value="正在读取本机状态…")
        self.schedule_text = tk.StringVar(value="")
        self.mode_text = tk.StringVar(value="")
        self.message_text = tk.StringVar(value="更新代码与启动自动回复分别操作。")
        self.stage_text = tk.StringVar(value="就绪")
        self._build()
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        self._poll_id = self.window.after(50, self._poll)
        self.refresh()
        self._watch_id = self.window.after(2000, self._watch)

    def _build(self):
        self.window.title("城市招聘 · 客户端管理")
        self.window.geometry("900x760")
        self.window.minsize(820, 740)
        self.window.configure(bg=BACKGROUND)
        self.window.option_add("*Font", ("Microsoft YaHei UI", 10))
        style = ttk.Style(self.window)
        style.theme_use("clam")
        style.configure("TButton", padding=(16, 9), font=("Microsoft YaHei UI", 10))
        style.configure("Primary.TButton", background=BLUE, foreground="white", borderwidth=0)
        style.map("Primary.TButton", background=[("disabled", "#d5ddeb"), ("active", "#1849b8")], foreground=[("disabled", "#7c889a")])
        style.configure("Horizontal.TProgressbar", background=BLUE, troughcolor="#e8edf5", borderwidth=0)
        outer = tk.Frame(self.window, bg=BACKGROUND, padx=28, pady=24)
        outer.pack(fill="both", expand=True)
        tk.Label(outer, text="城市招聘  /  WINDOWS 客户端", bg=BACKGROUND, fg=MUTED, font=("Microsoft YaHei UI", 10)).pack(anchor="w")
        header = tk.Frame(outer, bg=BACKGROUND)
        header.pack(fill="x", pady=(8, 16))
        tk.Label(header, text="客户端管理", bg=BACKGROUND, fg=INK, font=("Microsoft YaHei UI", 24, "bold")).pack(side="left")
        self.refresh_button = ttk.Button(header, text="刷新状态", command=self.refresh)
        self.refresh_button.pack(side="right")

        status = tk.Frame(outer, bg="white", padx=20, pady=16)
        status.pack(fill="x")
        self.runtime_label = tk.Label(status, textvariable=self.runtime_text, bg="white", fg=INK, font=("Microsoft YaHei UI", 13, "bold"))
        self.runtime_label.pack(anchor="w")
        tk.Label(status, textvariable=self.schedule_text, bg="white", fg=MUTED).pack(anchor="w", pady=(5, 0))
        tk.Label(status, textvariable=self.mode_text, bg="white", fg=INK, wraplength=790, justify="left").pack(anchor="w", pady=(5, 0))

        versions = tk.Frame(outer, bg=BACKGROUND)
        versions.pack(fill="x", pady=(16, 12))
        for title, variable in (("当前安装版本", self.current_text), ("已发布可用版本", self.latest_text)):
            box = tk.Frame(versions, bg="white", padx=16, pady=14)
            box.pack(side="left", fill="x", expand=True, padx=(0, 8) if title == "当前安装版本" else (8, 0))
            tk.Label(box, text=title, bg="white", fg=MUTED).pack(anchor="w")
            entry = tk.Entry(box, textvariable=variable, relief="flat", readonlybackground="white", fg=INK, state="readonly", font=("Consolas", 9), width=41)
            entry.pack(fill="x", pady=(8, 0))

        actions = tk.Frame(outer, bg=BACKGROUND)
        actions.pack(fill="x", pady=(0, 14))
        self.check_button = ttk.Button(actions, text="检查更新", command=self.check)
        self.check_button.pack(side="left")
        self.install_button = ttk.Button(actions, text="下载并更新", style="Primary.TButton", command=self.install)
        self.install_button.pack(side="left", padx=10)
        self.import_button = ttk.Button(actions, text="导入本地更新包", command=self.import_package)
        self.import_button.pack(side="left", padx=4)

        control = tk.Frame(outer, bg="white", padx=18, pady=14)
        control.pack(fill="x")
        description = tk.Frame(control, bg="white")
        description.pack(side="left")
        tk.Label(description, text="自动回复", bg="white", fg=INK, font=("Microsoft YaHei UI", 12, "bold")).pack(anchor="w")
        tk.Label(description, text="启动后将处理客户消息；关闭本窗口不会停止回复。", bg="white", fg=MUTED, font=("Microsoft YaHei UI", 9)).pack(anchor="w", pady=(5, 0))
        self.stop_button = ttk.Button(control, text="停止回复", command=self.stop)
        self.stop_button.pack(side="right")
        self.start_button = ttk.Button(control, text="启动回复", command=self.start)
        self.start_button.pack(side="right", padx=8)
        self.restart_button = ttk.Button(control, text="重启回复", command=self.restart)
        self.restart_button.pack(side="right")

        tk.Label(outer, textvariable=self.message_text, bg=BACKGROUND, fg=INK, anchor="w", justify="left", wraplength=825).pack(fill="x", pady=(16, 6))
        progress = tk.Frame(outer, bg=BACKGROUND)
        progress.pack(fill="x")
        tk.Label(progress, textvariable=self.stage_text, bg=BACKGROUND, fg=MUTED, font=("Microsoft YaHei UI", 9)).pack(side="left")
        self.progress = ttk.Progressbar(progress, mode="indeterminate", length=200)
        self.progress.pack(side="right")
        self.details = tk.Text(outer, height=5, relief="flat", bg="#e9eef6", fg=MUTED, font=("Microsoft YaHei UI", 9), wrap="word", padx=10, pady=8, state="disabled")
        self.details.pack(fill="both", expand=True, pady=(10, 12))
        footer = tk.Frame(outer, bg=BACKGROUND)
        footer.pack(fill="x")
        tk.Label(footer, text="更新源：GitHub Release  ·  安装前请先停止回复", bg=BACKGROUND, fg=MUTED, font=("Microsoft YaHei UI", 9)).pack(side="left")
        ttk.Button(footer, text="打开日志目录", command=self.open_logs).pack(side="right")
        self._buttons()

    def _buttons(self):
        stopped = self.state is not None and not self.state["running"] and not self.state.get("other_running")
        up_to_date = bool(
            self.release
            and self.state
            and self.state.get("commit") == self.release.get("commit")
        )
        self.check_button.state(["disabled"] if self.busy else ["!disabled"])
        self.refresh_button.state(["disabled"] if self.busy else ["!disabled"])
        self.install_button.configure(text="已是最新版本" if up_to_date else "下载并更新")
        can_install = not self.busy and stopped and self.release and not up_to_date
        self.install_button.state(["!disabled"] if can_install else ["disabled"])
        self.import_button.state(["!disabled"] if not self.busy and stopped else ["disabled"])
        self.restart_button.state(["!disabled"] if not self.busy and self.state and self.state["running"] and not self.state.get("other_running") else ["disabled"])
        start_label, start_action = self._start_control()
        self.start_button.configure(text=start_label)
        self.start_button.state(["!disabled"] if not self.busy and start_action else ["disabled"])
        self.stop_button.state(["!disabled"] if not self.busy and self.state and self.state["running"] else ["disabled"])

    def _start_control(self) -> tuple[str, str | None]:
        if self.state is None or self.state.get("other_running") or self.state["running"] > 1:
            return "启动回复", None
        if not self.state["running"]:
            return "启动回复", "start"
        startup = self.state.get("startup_status")
        mode = self.state.get("reply_mode")
        if startup == "ready" and _reply_mode_ready(mode) and not _recipient_verification_blocked(mode):
            return "回复已启动", None
        if startup in {"ready", "failed"}:
            return "恢复回复", "restart"
        labels = {"waiting_login": "等待企微登录", "waiting_wecom": "等待打开企微"}
        return labels.get(startup, "回复启动中"), None

    def _record(self, text):
        self.details.configure(state="normal")
        self.details.insert("end", f"{time.strftime('%H:%M:%S')}  {text}\n")
        self.details.see("end")
        self.details.configure(state="disabled")

    def _run(self, operation, function):
        if self.busy or self.closed:
            return
        self.status_generation += 1
        self.busy = True
        self.operation = operation
        self.stage_text.set({"status": "读取本机状态…", "check": "查询已发布版本…", "update": "准备更新…", "start": "正在启动回复…", "stop": "正在停止回复…", "restart": "正在重启回复…", "import": "正在校验本地更新包…"}[operation])
        self.progress.start(12)
        self._buttons()
        def worker():
            try:
                result = function()
                try:
                    state = result if operation == "status" else self.service.status()
                except Exception:
                    state = None
                self.events.put(("done", operation, result, state))
            except Exception as exc:
                self.events.put(("error", operation, exc))
        threading.Thread(target=worker, daemon=True).start()

    def _apply_state(self, state, *, watched=False):
        self.state = state
        self.mode_text.set(reply_mode_text(state))
        if state is None:
            self.current_text.set("状态不可用，请刷新")
            self.runtime_text.set("状态读取失败，请刷新后再操作")
            self.schedule_text.set("")
            return
        self.current_text.set(state["commit"] or "尚未登记版本（本地部署）")
        count = state["running"]
        startup_status = state.get("startup_status")
        status_text = {
            "starting": "自动回复启动中…",
            "waiting_wecom": "等待打开企业微信",
            "waiting_login": "等待扫码登录企业微信",
            "initializing": "企业微信已登录，正在初始化数据库…",
            "ready": "本机回复已就绪" if count == 1 else "回复进程数量异常",
            "failed": "自动回复启动失败",
            "stopped": "自动回复已停止",
        }
        if not startup_status:
            startup_status = "starting" if count else "stopped"
        self.runtime_text.set(status_text.get(startup_status, "自动回复状态未知"))
        if state.get("startup_detail") and (not watched or startup_status == "failed"):
            self.message_text.set(state["startup_detail"])
        mode = state.get("reply_mode")
        healthy = False
        if startup_status == "ready" and count == 1:
            if _recipient_verification_blocked(mode):
                self.runtime_text.set("发送受阻：未通过企微收件人核验")
            elif _reply_mode_ready(mode):
                healthy = True
            else:
                self.runtime_text.set("自动回复等待确认")
        self.runtime_label.configure(fg="#15724a" if healthy else INK)
        enabled = state["task_enabled"]
        schedule = "登录自动启动已启用" if enabled is True else "登录自动启动已暂停" if enabled is False else "未能读取登录自动启动任务"
        if state.get("other_running"):
            schedule += " · 检测到其他路径的回复进程，暂不允许安装或启动"
        self.schedule_text.set(schedule)

    def _watch(self):
        if self.closed:
            return
        self._watch_id = self.window.after(2000, self._watch)
        if (self.busy and self.operation != "check") or self.watch_pending:
            return
        previous = self.state
        now = time.monotonic()
        full = previous is None or (not previous["running"] and now >= self.next_inventory)
        if not full and not previous["running"]:
            return
        if full:
            self.next_inventory = now + 20
        self.watch_pending = True
        generation = self.status_generation

        def worker():
            try:
                state = self.service.status() if full else self.service.watch_status(previous)
            except Exception:
                state = None
            self.events.put(("watch", generation, state))

        threading.Thread(target=worker, daemon=True).start()

    def _poll(self):
        if self.closed:
            return
        while not self.events.empty():
            event = self.events.get()
            if event[0] == "watch":
                self.watch_pending = False
                _, generation, state = event
                if generation == self.status_generation and (not self.busy or self.operation == "check"):
                    self._apply_state(state, watched=True)
                    self._buttons()
                continue
            if event[0] == "stage":
                self.stage_text.set(event[1])
                continue
            _, operation, result, *rest = event
            self.busy = False
            self.operation = None
            self.progress.stop()
            self.progress.configure(value=0)
            self.stage_text.set("就绪")
            if event[0] == "error":
                if operation == "check":
                    self.release = None
                    self.latest_text.set("检查失败")
                if operation == "status":
                    self._apply_state(None)
                if operation in {"start", "stop", "restart"}:
                    self.next_inventory = 0
                    self._apply_state(None)
                stage = {"check": "查询发布版本失败", "update": "更新失败", "import": "导入失败"}.get(operation, "操作失败")
                self.message_text.set(stage + "：" + friendly_error(result))
                self._record(str(result))
                if operation != "status":
                    updater._log_event(self.service.root, f"manager {operation} failed: {result}")
            else:
                self._apply_state(rest[0])
                if operation == "check":
                    self.release = result
                    self.latest_text.set(result["commit"])
                    current = self.state.get("commit") if self.state else None
                    if result.get("pending_main"):
                        self.message_text.set("最新提交的安装包还在发布。上方为当前可用的完整版本。")
                    else:
                        self.message_text.set("当前已是该发布版本，无需重复安装。" if current == result["commit"] else "发现已发布版本。停止回复后点击「下载并更新」。")
                elif operation in {"update", "import"}:
                    self.message_text.set(f"更新完成，校验安装了 {len(result['changed'])} 个变更文件。自动回复未启动。")
                    self._record(f"已安装 {result['commit']}；再次打开窗口可加载新版管理界面。")
                elif operation in {"start", "restart"}:
                    start_status = (self.state or {}).get("startup_status")
                    if start_status == "waiting_login":
                        self.message_text.set("企业微信尚未登录，请扫码；二维码会继续按节流周期上传。")
                    elif start_status == "waiting_wecom":
                        self.message_text.set("请先打开企业微信，客户端会继续等待，不会初始化数据库。")
                    elif start_status == "initializing":
                        self.message_text.set("已启动，正在初始化数据库；初始化完成后才会处理消息。")
                    elif start_status == "ready" and self.state["running"]:
                        self.message_text.set("本机已就绪，网页在线状态以实际心跳为准。")
                    else:
                        self.message_text.set("正在等待确认启动结果，请查看当前状态。")
                elif operation == "stop":
                    self.message_text.set("自动回复进程已停止。请核对停止时正在处理的消息，避免重复发送。")
            self._buttons()
        self._poll_id = self.window.after(50, self._poll)

    def refresh(self):
        self._run("status", self.service.status)

    def check(self):
        if self.busy:
            return
        self.release = None
        self._run("check", self.service.check)

    def install(self):
        if not self.release or self.busy:
            return
        commit = self.release["commit"]
        # 用 update_or_restore：安装失败时把原来在跑的客户端恢复起来，避免停在「已停止」
        self._run("update", lambda: self.service.update_or_restore(commit, progress=lambda text: self.events.put(("stage", text))))

    def import_package(self):
        if self.busy:
            return
        filename = filedialog.askopenfilename(
            parent=self.window, title="选择官方更新包（同目录需有 windows-client.sha256）",
            filetypes=[("Windows 客户端安装包", "*.zip")],
        )
        if filename and messagebox.askyesno(
            "确认安装包来源",
            "请确认 ZIP 和 windows-client.sha256 均来自同一次官方 GitHub 发布。\n是否校验并安装？",
            parent=self.window,
        ):
            self._run("import", lambda: self.service.import_package(Path(filename)))

    def restart(self):
        if self.busy:
            return
        if messagebox.askyesno("重启自动回复", "将停止当前进程并重新启动自动回复。\n是否继续？", parent=self.window):
            self._run("restart", self.service.restart)

    def start(self):
        if self.busy:
            return
        _, action = self._start_control()
        if action == "restart":
            self.restart()
            return
        if action != "start":
            return
        if messagebox.askyesno("启动自动回复", "启动后将开始处理客户消息。\n请确认错会话等未解决问题已复核。\n\n是否现在启动？", parent=self.window):
            self._run("start", self.service.start)

    def stop(self):
        if self.busy:
            return
        if messagebox.askyesno("停止自动回复", "将结束本客户端的回复进程，可能中断当前消息处理。\n不会关闭企业微信；停止后请核对未确定的发送结果。\n\n是否停止？", parent=self.window):
            self._run("stop", self.service.stop)

    def open_logs(self):
        folder = self.service.root / "logs"
        folder.mkdir(parents=True, exist_ok=True)
        os.startfile(str(folder))

    def close(self):
        if self.busy and self.operation in {"update", "import", "start", "stop", "restart"}:
            messagebox.showinfo("操作尚未结束", "请等待本次操作完成再关闭窗口。", parent=self.window)
            return
        self.closed = True
        self.window.after_cancel(self._poll_id)
        self.window.after_cancel(self._watch_id)
        self.window.destroy()


def main():
    window = tk.Tk()
    ManagerWindow(window, ManagerService(Path(__file__).resolve().parent))
    window.mainloop()


if __name__ == "__main__":
    main()
