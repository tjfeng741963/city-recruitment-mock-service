"""Exercise the actual publication shell with a local GitHub CLI double."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest


REPO = Path(__file__).resolve().parents[2]
GIT_BASH = Path("C:/Program Files/Git/bin/bash.exe")
BASH = str(GIT_BASH) if GIT_BASH.is_file() else shutil.which("bash")
SHA = "a" * 40

MOCK_GH = r'''
import json,os,shutil,sys
from pathlib import Path
sys.stdout.reconfigure(newline='\n')
p=Path(os.environ['MOCK_STATE']); s=json.loads(p.read_text()); args=sys.argv[1:]
def save(): p.write_text(json.dumps(s))
def arg(name): return args[args.index(name)+1]
if args[0]=='api':
 if '--method' in args:
  s['tag']=os.environ['SHA']; save()
 elif not s.get('tag'): sys.exit(1)
 elif '--jq' in args: print('commit\t'+s['tag'])
else:
 action=args[1]
 if action=='view':
  if not s['exists']: sys.exit(1)
  field=arg('--json') if '--json' in args else ''
  if field=='isDraft': print(str(s['draft']).lower())
  elif field=='isPrerelease': print('false')
  elif field=='assets': print('\n'.join(s['assets']))
 elif action=='create':
  s.update(exists=True,draft=True); s['creates']+=1
  for name in ('windows-client.zip','windows-client.sha256'):
   shutil.copy2(name,Path(os.environ['MOCK_ASSETS'])/name); s['assets'].append(name)
   if s.get('interrupt'):
    s['interrupt']=False; save(); sys.exit(1)
  save()
 elif action=='download':
  name=arg('--pattern'); destination=Path(arg('--dir'))/name
  assert name in s['assets']
  shutil.copy2(Path(os.environ['MOCK_ASSETS'])/name,destination)
 elif action=='upload':
  name=args[3]; assert s['draft'] and name not in s['assets']
  shutil.copy2(name,Path(os.environ['MOCK_ASSETS'])/name)
  s['assets'].append(name); s['uploads']+=1; save()
 elif action=='edit':
  assert s['draft']; s['draft']=False; s['publishes']+=1; save()
 else: raise AssertionError(args)
'''


@pytest.mark.skipif(not BASH, reason="Bash required for workflow shell verification")
@pytest.mark.parametrize("scenario", ["new", "interrupted", "published", "conflict", "wrong-tag"])
def test_release_publication_recovers_drafts_without_overwriting_assets(tmp_path, scenario):
    workflow = (REPO / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
    step = workflow.split("- name: Verify or publish the immutable client release", 1)[1]
    shell = textwrap.dedent(step.split("        run: |\n", 1)[1])
    assets = tmp_path / "remote-assets"
    assets.mkdir()
    package_dir = tmp_path / "dist/windows-client"
    package_dir.mkdir(parents=True)
    (package_dir / "windows-client.zip").write_bytes(b"verified package")
    import hashlib
    checksum = hashlib.sha256(b"verified package").hexdigest() + "  windows-client.zip\n"
    (package_dir / "windows-client.sha256").write_text(checksum, encoding="ascii", newline="\n")
    exists = scenario in ("published", "conflict")
    initial = dict(exists=exists, draft=False, tag=SHA if scenario != "wrong-tag" else "b" * 40,
                   assets=["windows-client.zip", "windows-client.sha256"] if exists else [],
                   creates=0, uploads=0, publishes=0, interrupt=scenario == "interrupted")
    if scenario == "new":
        initial["tag"] = None
    for name in initial["assets"]:
        shutil.copy2(package_dir / name, assets / name)
    if scenario == "conflict":
        (assets / "windows-client.zip").write_bytes(b"other package")
    state = tmp_path / "state.json"
    state.write_text(json.dumps(initial), encoding="utf-8")
    mock = tmp_path / "mock_gh.py"
    mock.write_text(MOCK_GH, encoding="utf-8")
    script = tmp_path / "publish.sh"
    # A shell function ensures no network-capable gh binary is ever executed.
    script.write_text('gh() { python "$MOCK_GH" "$@"; }\n' + shell, encoding="utf-8", newline="\n")
    env = {**os.environ, "SHA": SHA, "GH_REPO": "fixture/repo", "GH_TOKEN": "fixture",
           "MOCK_STATE": state.as_posix(), "MOCK_ASSETS": assets.as_posix(), "MOCK_GH": mock.as_posix()}
    result = subprocess.run([BASH, script.as_posix()], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30)
    if scenario == "interrupted":
        assert result.returncode != 0
        assert json.loads(state.read_text())["assets"] == ["windows-client.zip"]
        result = subprocess.run([BASH, script.as_posix()], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30)
    final = json.loads(state.read_text())
    if scenario in ("conflict", "wrong-tag"):
        assert result.returncode != 0
        assert ("wrong commit" in result.stderr) if scenario == "wrong-tag" else ("differ" in result.stdout)
        assert final["publishes"] == final["uploads"] == final["creates"] == 0
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        assert final["draft"] is False
        assert set(final["assets"]) == {"windows-client.zip", "windows-client.sha256"}
        assert final["publishes"] == (0 if scenario == "published" else 1)
        assert final["uploads"] == (1 if scenario == "interrupted" else 0)
