import json
from pathlib import Path

p = Path("C:/cloud-agent/.greeted.json")
data = json.loads(p.read_text(encoding="utf-8"))
before = len(data.get("sessions", []))
data["sessions"] = [s for s in data.get("sessions", []) if "7881299918302353" not in s]
p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
print(f"sessions {before} -> {len(data['sessions'])}（已移除青冥）")
