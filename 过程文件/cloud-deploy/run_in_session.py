# -*- coding: utf-8 -*-
"""通用：把本地一个 py 脚本以交互式会话（session 2）方式在 134 上跑一次，回收输出。

用法：
  python 过程文件/cloud-deploy/run_in_session.py 过程文件/cloud-deploy/probe_win.py C:/agent/probe-win.out
"""
from __future__ import annotations

import os
import sys
import time

import cx

# 必须用 pythonw：python.exe 会弹黑色控制台并压在企微上面，
# 之后所有点击/按键都打在控制台上（2026-11-26 排查两小时才定位）
PY = r"C:\PROGRA~1\Python311\pythonw.exe"
PASSWORD = "QWERasdf@12345"
TASK = "RunInSessionOnce"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    local = sys.argv[1]
    remote_out = sys.argv[2] if len(sys.argv) > 2 else "C:/agent/run-in-session.out"
    name = os.path.basename(local)
    c = cx.connect()
    sftp = c.open_sftp()
    try:
        sftp.put(local, "C:/agent/" + name)
        try:
            sftp.remove(remote_out)
        except OSError:
            pass
        remote_script = "C:\\agent\\" + name
        create = (
            'schtasks /create /tn {task} /tr "{py} {script}" /sc once /st 23:59 '
            '/ru Administrator /rp "{pw}" /it /f'
        ).format(task=TASK, py=PY, script=remote_script, pw=PASSWORD)
        print(cx.run(c, create, timeout=60))
        print(cx.run(c, "schtasks /run /tn " + TASK, timeout=60))
        got = None
        for _ in range(12):
            time.sleep(2)
            try:
                with sftp.open(remote_out, "r") as fh:
                    got = fh.read().decode("utf-8", "ignore")
                break
            except OSError:
                continue
        if got:
            print("=== output ===")
            print(got)
        else:
            print("!!! 无输出文件，任务结果：")
            print(cx.run(c, "schtasks /query /tn " + TASK + " /v /fo list", timeout=60))
        cx.run(c, "schtasks /delete /tn " + TASK + " /f", timeout=60)
    finally:
        sftp.close()
        c.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
