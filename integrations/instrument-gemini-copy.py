#!/usr/bin/env python3
"""Add metadata-only usage capture to the existing gemini-copy helper.

No API calls. Saves a backup and refuses an unfamiliar helper layout.
"""
import argparse
import datetime
from pathlib import Path
import shutil

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--home", type=Path, default=Path.home())
args = parser.parse_args()
target = args.home / "bin/gemini-copy"
source = target.read_text()
anchor = "import json, sys, urllib.request, urllib.error\n"
response = "    body = json.load(urllib.request.urlopen(req, timeout=120))\n"
marker = "# buildstats: metadata-only Gemini usage"
if marker not in source:
    if source.count(anchor) != 1 or source.count(response) != 1:
        raise SystemExit("Unrecognised gemini-copy layout; no files changed")
    source = source.replace(anchor, anchor + "import datetime, pathlib, runpy\n"
        "started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()\n")
    # Outside the HTTP exception block: usage capture must not swallow API errors.
    before = '\ntry:\n    cand = body["candidates"][0]'
    if source.count(before) != 1:
        raise SystemExit("Unrecognised gemini-copy response block; no files changed")
    capture = '''
# buildstats: metadata-only Gemini usage
try:
    recorder = runpy.run_path(str(pathlib.Path.home() / '.buildstats/gemini_usage.py'))
    recorder['record_usage'](body, model, started_at, work='Writing')
except Exception as usage_error:
    print('gemini-copy: usage was not recorded (' + type(usage_error).__name__ + ')', file=sys.stderr)
'''
    source = source.replace(before, capture + before)
    backup_dir = args.home / ".buildstats/backups"
    backup_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    shutil.copy2(target, backup_dir / ("gemini-copy." + date + ".bak"))
    target.write_text(source)
module = args.home / ".buildstats/gemini_usage.py"
module.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
shutil.copyfile(Path(__file__).with_name("gemini_usage.py"), module)
module.chmod(0o600)
js_module = args.home / ".buildstats/gemini-usage.mjs"
shutil.copyfile(Path(__file__).with_name("gemini-usage.mjs"), js_module)
js_module.chmod(0o600)
print("gemini-copy usage capture installed; no API call made")
