import sys

sys.path.insert(0, "C:/cloud-agent")
import client as agent_client

b = agent_client.BridgeClient(
    "http://127.0.0.1:18080",
    "agt-2ab891997a9433e52058f9387e8bda0078f75a775d670014",
    "AG-SZDT01",
)
print("enabled:", b.enabled)
try:
    result = b.heartbeat("online", account_id="1688858186855249")
    print("心跳结果:", result)
except Exception as exc:
    print("心跳失败:", type(exc).__name__, exc)
