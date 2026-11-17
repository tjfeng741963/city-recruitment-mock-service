import sys
import time

sys.path.insert(0, "C:/cloud-agent")

t0 = time.time()
from wecom_io_core.store import Store

store = Store()
print(f"Store 构造 {time.time()-t0:.1f}s", flush=True)
t1 = time.time()
sid = store.self_id()
print(f"self_id={sid!r} 耗时 {time.time()-t1:.1f}s", flush=True)
