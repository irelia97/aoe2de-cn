#!/usr/bin/env python3
"""Read-only checks; failures are surfaced through systemd and its journal."""
import json
import urllib.request
import subprocess
import shutil

with urllib.request.urlopen('http://127.0.0.1:3000/api/internal/health', timeout=10) as response:
    health = json.load(response)
if not health.get('ok') or not health.get('background', {}).get('ok'):
    raise SystemExit('Site/background health check failed')
for unit in ('aoe2de.service', 'aoe2-background.service', 'douyu-command-listener.service', 'douyu-command-listener-1029928.service', 'nginx.service'):
    subprocess.run(['/usr/bin/systemctl', 'is-active', '--quiet', unit], check=True, timeout=5)
with urllib.request.urlopen('https://aoe2cn.cc/', timeout=10) as response:
    if response.status != 200:
        raise SystemExit('Public HTTPS health check failed')
if shutil.disk_usage('/opt/aoe2de-cn').free < 1024 * 1024 * 1024:
    raise SystemExit('Less than 1 GiB disk space available')
print(json.dumps({'ok': True, 'webUptime': health['uptime'], 'workerUptime': health['background']['uptime']}))
