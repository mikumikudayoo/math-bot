"""Run via sudo on the audited /opt installation; output never includes secrets."""
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import sqlite3
import subprocess

root = pathlib.Path('/opt/math-bot')
if not root.is_dir() or root.is_symlink():
    raise RuntimeError('Expected audited /opt installation')
user = pwd.getpwnam('mathbot')

def git(*args):
    return subprocess.check_output(['sudo', '-u', 'mathbot', 'git', *args], cwd=root)

# Inspect before creating the backup. Git runs as its repository owner.
sha = git('rev-parse', 'HEAD').decode().strip()
status = git('status', '--porcelain')
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = root / 'backups' / ('announcement-predeploy-' + stamp)
backup.mkdir(mode=0o700)
manifest = {'created_at': stamp, 'production_sha': sha, 'databases': {}, 'protected_files': {}}
for name in ['qotd.sqlite', 'admin.production.sqlite', 'reminders.production.sqlite',
             'production.sqlite', 'announcements.production.sqlite']:
    source = root / 'data' / name
    if not source.exists():
        continue
    target = backup / name
    src = sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
        if dst.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('Backup integrity check failed')
        manifest['databases'][name] = 'quick_check=ok'
    finally:
        dst.close()
        src.close()
    target.chmod(0o600)
for name in ['.env.production', '.env.ai.production', '.env.automation.production',
             'training/aleph/holdout.jsonl', 'training/aleph/reviewed.jsonl',
             'training/aleph/train.jsonl', 'training/aleph/split-manifest.json', 'aleph-baseline.py']:
    source = root / name
    if not source.is_file():
        continue
    target = backup / name
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    shutil.copyfile(source, target)
    target.chmod(0o600)
    if not name.startswith('.env'):
        manifest['protected_files'][name] = hashlib.sha256(source.read_bytes()).hexdigest()
if (root / 'dist').is_dir():
    subprocess.run(['tar', '-czf', str(backup / 'dist.tar.gz'), '-C', str(root), 'dist'],
                   check=True, capture_output=True)
pm2 = subprocess.run(['sudo', '-u', 'mathbot', 'env', 'PM2_HOME=/home/mathbot/.pm2',
                      '/usr/local/bin/pm2', 'jlist'], capture_output=True, check=True)
(backup / 'pm2-private.json').write_bytes(pm2.stdout)
(backup / 'git-status.txt').write_bytes(status)
(backup / 'manifest.json').write_text(json.dumps(manifest, indent=2))
for directory, dirs, files in os.walk(backup):
    os.chown(directory, user.pw_uid, user.pw_gid)
    os.chmod(directory, 0o700)
    for name in files:
        path = pathlib.Path(directory) / name
        os.chown(path, user.pw_uid, user.pw_gid)
        os.chmod(path, 0o600)
print(json.dumps({'backup_directory': str(backup), 'production_sha': sha,
                  'databases': manifest['databases'], 'services_restarted': False}))
