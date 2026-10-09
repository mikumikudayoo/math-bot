"""Explicit, announcement-only production reset. Run with sudo after deployment.

SQLite's backup API replaces contents in place so the bot's open announcement
connection observes the clean DB without an unsafe rename of live WAL files.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import subprocess
import time


ROOT = Path('/opt/math-bot')


def as_bot(*args):
    result = subprocess.run(['sudo', '-u', 'mathbot', 'env', 'BOT_ENV=production',
                             'PM2_HOME=/home/mathbot/.pm2', *args], cwd=ROOT,
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError('Announcement operator command failed; inspect private status.')
    return result.stdout


def checked_path(path):
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT.resolve()):
        raise RuntimeError('Announcement path escapes the deployment directory.')
    return resolved


def verify(path):
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise RuntimeError('Announcement SQLite integrity verification failed.')


def snapshot(source, destination):
    destination = checked_path(destination)
    if destination.exists():
        raise RuntimeError('Refusing to overwrite an existing announcement snapshot.')
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as src:
        with sqlite3.connect(destination) as dst:
            src.backup(dst)
            dst.execute('PRAGMA journal_mode=DELETE')
    os.chmod(destination, 0o600)
    os.chown(destination, pwd.getpwnam('mathbot').pw_uid, pwd.getpwnam('mathbot').pw_gid)
    verify(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-revision', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch('[a-f0-9]{40}', args.expected_revision):
        raise RuntimeError('Run as root with the exact reviewed release revision.')
    if as_bot('git', 'rev-parse', 'HEAD').strip() != args.expected_revision:
        raise RuntimeError('Production revision changed; reconcile before resetting.')
    config = json.loads(as_bot('/usr/local/bin/bun', '-e',
        "import {automationConfig} from './dist/announcements/config.js';const c=automationConfig();console.log(JSON.stringify({database:c.database,enabled:c.enabled,autoSend:c.autoSend,policies:c.policy.policies.length}));"))
    active = checked_path(Path(config['database']))
    if active != ROOT / 'data/announcements.production.sqlite' or not config['enabled'] or config['autoSend']:
        raise RuntimeError('Expected dedicated production DB and shadow-only gates.')
    processes = json.loads(as_bot('pm2', 'jlist'))
    worker = next(p for p in processes if p['name'] == 'aleph-zero-automation')
    bot = next(p for p in processes if p['name'] == 'aleph-zero-bot')
    if worker['pm2_env']['status'] != 'stopped' or bot['pm2_env']['status'] != 'online':
        raise RuntimeError('Stop only the worker; keep the announcement-aware bot online.')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_dir = checked_path(ROOT / 'backups' / ('announcements-future-only-' + stamp))
    archive_dir = checked_path(ROOT / 'data/announcement-archives')
    backup_dir.mkdir(mode=0o700)
    archive_dir.mkdir(mode=0o700, exist_ok=True)
    backup = backup_dir / 'announcements.before-reset.sqlite'
    archive = archive_dir / ('announcements.historical-shadow.' + stamp + '.sqlite')
    clean = checked_path(ROOT / 'data' / ('announcements.clean.' + stamp + '.sqlite'))
    installed = False
    requested_at = int(time.time() * 1000)
    with sqlite3.connect(active) as db:
        db.execute("INSERT INTO gmail_state VALUES('maintenance:reset','true') ON CONFLICT(key) DO UPDATE SET value='true'")
    try:
        deadline = time.monotonic() + 90
        while True:
            with sqlite3.connect(active) as db:
                row = db.execute("SELECT value FROM gmail_state WHERE key='maintenance:bot-ack'").fetchone()
            if row and int(row[0]) >= requested_at:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Bot did not acknowledge announcement maintenance; no DB replacement occurred.')
            time.sleep(0.5)
        snapshot(active, backup)  # Verified BEFORE archival/replacement.
        snapshot(backup, archive)  # Historical contents retained independently.
        clean.touch(mode=0o600, exist_ok=False)
        user = pwd.getpwnam('mathbot')
        os.chown(clean, user.pw_uid, user.pw_gid)
        bootstrap = json.loads(as_bot('/usr/local/bin/bun', 'dist/scripts/announcement-bootstrap.js', '--database', str(clean)))
        verify(clean)
        with sqlite3.connect(clean.as_uri() + '?mode=ro', uri=True) as src:
            with sqlite3.connect(active, timeout=30) as dst:
                src.backup(dst)
        installed = True
        verify(active)
        with sqlite3.connect(active.as_uri() + '?mode=ro', uri=True) as db:
            counts = {table: db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0]
                      for table in ['sources', 'candidate_events', 'events', 'announcement_jobs']}
        if any(counts.values()):
            raise RuntimeError('Clean bootstrap unexpectedly contains announcement records.')
        report = {'revision': args.expected_revision, 'backup_path': str(backup),
                  'archive_path': str(archive), 'active_path': str(active),
                  'staging_path': str(clean), 'bootstrap': bootstrap, 'counts': counts,
                  'integrity': 'ok', 'autoSend': False, 'bot_stayed_running': True}
        report_path = backup_dir / 'reset-report.json'
        report_path.write_text(json.dumps(report, indent=2))
        os.chmod(report_path, 0o600)
        print(json.dumps(report))
    finally:
        if not installed:
            with sqlite3.connect(active) as db:
                db.execute("DELETE FROM gmail_state WHERE key IN ('maintenance:reset','maintenance:bot-ack')")


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error), 'worker_remains_stopped': True}))
        raise SystemExit(1)
