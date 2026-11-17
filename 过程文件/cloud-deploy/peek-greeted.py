import json
from pathlib import Path

for cand in [Path("C:/agent/.greeted.json"), Path("C:/cloud-agent/.greeted.json")]:
    print("==", cand, "存在:", cand.exists())
    if cand.exists():
        raw = cand.read_text(encoding="utf-8")
        print(raw[:500])
