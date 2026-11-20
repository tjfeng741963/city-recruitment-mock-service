"""Windows client management window; opening it never starts automatic replies."""

from __future__ import annotations

import os
from pathlib import Path
import queue
import threading
import time
import tkinter as tk
from tkinter import messagebox, ttk

import client_updater as updater
from client_manager_service import ManagerService


BACKGROUND = "#f2f5fa"
INK = "#192940"
MUTED = "#5d6c80"
BLUE = "#235bd8"


def friendly_error(exc: Exception) -> str:
    text = str(exc)
    if any(word in text for word in ("HTTPS", "GitHub", "HTTP", "urlopen", "timed out")):
        return "无法取得更新。请检查网络；当前 main 的客户端包也可能尚未发布。已安装的代码未因此改变，请稍后重试。"
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
        self.current_text = tk.StringVar(value="读取中…")
        self.latest_text = tk.StringVar(value="点击「检查更新」获取")
        self.runtime_text = tk.StringVar(value="正在读取本机状态…")
        self.schedule_text = tk.StringVar(value="")
        self.message_text = tk.StringVar(value="更新代码与启动自动回复分别操作。")
        self.stage_text = tk.StringVar(value="就绪")
        self._build()
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        self._poll_id = self.window.after(50, self._poll)
        self._refresh_id = self.window.after(5000, self._auto_refresh)
        self.refresh()

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
        tk.Label(actions, text="安装完成后保持停止", bg=BACKGROUND, fg=MUTED).pack(side="left", padx=4)

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
        self.check_button.state(["disabled"] if self.busy else ["!disabled"])
        self.refresh_button.state(["disabled"] if self.busy else ["!disabled"])
        self.install_button.state(["!disabled"] if not self.busy and stopped and self.release else ["disabled"])
        self.start_button.state(["!disabled"] if not self.busy and stopped else ["disabled"])
        self.stop_button.state(["!disabled"] if not self.busy and self.state and self.state["running"] else ["disabled"])

    def _record(self, text):
        self.details.configure(state="normal")
        self.details.insert("end", f"{time.strftime('%H:%M:%S')}  {text}\n")
        self.details.see("end")
        self.details.configure(state="disabled")

    def _run(self, operation, function):
        if self.busy or self.closed:
            return
        self.busy = True
        self.operation = operation
        self.stage_text.set({"status": "读取本机状态…", "check": "查询已发布版本…", "update": "准备更新…", "start": "正在启动回复…", "stop": "正在停止回复…"}[operation])
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

    def _apply_state(self, state):
        self.state = state
        if state is None:
            self.current_text.set("状态不可用，请刷新")
            self.runtime_text.set("状态读取失败，请刷新后再操作")
            self.schedule_text.set("")
            return
        self.current_text.set(state["commit"] or "尚未登记版本（本地部署）")
        count = state["running"]
        self.runtime_text.set(f"自动回复运行中 · {count} 个进程" if count else "自动回复已停止")
        self.runtime_label.configure(fg="#15724a" if count else INK)
        enabled = state["task_enabled"]
        schedule = "登录自动启动已启用" if enabled is True else "登录自动启动已暂停" if enabled is False else "未能读取登录自动启动任务"
        if state.get("other_running"):
            schedule += " · 检测到其他路径的回复进程，暂不允许安装或启动"
        self.schedule_text.set(schedule)

    def _poll(self):
        if self.closed:
            return
        while not self.events.empty():
            event = self.events.get()
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
                    self.latest_text.set("检查失败 / 尚无可用包")
                if operation == "status":
                    self._apply_state(None)
                self.message_text.set("操作失败：" + friendly_error(result))
                self._record(str(result))
                if operation != "status":
                    updater._log_event(self.service.root, f"manager {operation} failed: {result}")
            else:
                self._apply_state(rest[0])
                if operation == "check":
                    self.release = result
                    self.latest_text.set(result["commit"])
                    current = self.state.get("commit") if self.state else None
                    self.message_text.set("当前已是该发布版本，可重新校验安装。" if current == result["commit"] else "发现已发布版本。停止回复后点击「下载并更新」。")
                elif operation == "update":
                    self.message_text.set(f"更新完成，校验安装了 {len(result['changed'])} 个变更文件。自动回复未启动。")
                    self._record(f"已安装 {result['commit']}；再次打开窗口可加载新版管理界面。")
                elif operation == "start":
                    self.message_text.set("已发现自动回复进程。请在业务后台核对在线状态与回复结果。")
                elif operation == "stop":
                    self.message_text.set("自动回复进程已停止。请核对停止时正在处理的消息，避免重复发送。")
            self._buttons()
        self._poll_id = self.window.after(50, self._poll)

    def _auto_refresh(self):
        if not self.closed:
            if not self.busy:
                self.refresh()
            self._refresh_id = self.window.after(5000, self._auto_refresh)

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
        self._run("update", lambda: self.service.update(commit, progress=lambda text: self.events.put(("stage", text))))

    def start(self):
        if self.busy:
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
        if self.busy and self.operation in {"update", "start", "stop"}:
            messagebox.showinfo("操作尚未结束", "请等待本次操作完成再关闭窗口。", parent=self.window)
            return
        self.closed = True
        self.window.after_cancel(self._poll_id)
        self.window.after_cancel(self._refresh_id)
        self.window.destroy()


def main():
    window = tk.Tk()
    ManagerWindow(window, ManagerService(Path(__file__).resolve().parent))
    window.mainloop()


if __name__ == "__main__":
    main()
