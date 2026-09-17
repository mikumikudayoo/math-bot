"""One SQL statement against a host-selected existing database, never a user path.

Stdlib SQLite's authorizer, limits and progress handler provide a bounded worker.
No extensions, attached databases, filesystem functions or SQL transaction control.
"""
import json
import resource
import sqlite3
import sys
import time
from pathlib import Path


def execute(path, sql):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=rw', uri=True, timeout=1)
    try:
        db.enable_load_extension(False)
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        db.execute('PRAGMA temp_store=MEMORY')
        db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 1_000_000)
        db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 4000)
        db.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 100)
        db.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
        deadline = time.monotonic() + 3
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        # Read-only schema inspection pragmas only; other pragmas can redirect files,
        # disable invariants or undermine the resource/transaction boundary.
        pragmas = {'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list'}
        blocked = {sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH, sqlite3.SQLITE_TRANSACTION,
                   sqlite3.SQLITE_SAVEPOINT, sqlite3.SQLITE_CREATE_VTABLE, sqlite3.SQLITE_DROP_VTABLE}

        def authorize(action, a, b, database, source):
            if action in blocked or (database and database not in ('main', 'temp')):
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_PRAGMA and (a or '').lower() not in pragmas:
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_FUNCTION and (b or '').lower() in {
                'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer'}:
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        db.execute('BEGIN IMMEDIATE')
        db.set_authorizer(authorize)
        before = db.total_changes
        cursor = db.execute(sql)  # execute rejects multiple statements, including hidden tails.
        columns = [column[0][:80] for column in cursor.description] if cursor.description else []
        rows, truncated, size = [], False, 0
        if columns:
            for row in cursor:
                values = []
                for value in row:
                    if isinstance(value, bytes):
                        value = '[blob omitted]'
                        truncated = True
                    elif isinstance(value, str) and len(value) > 200:
                        value = value[:200] + '…'
                        truncated = True
                    values.append(value)
                length = len(json.dumps(values))
                if len(rows) >= 20 or size + length > 8000:
                    truncated = True
                    break
                size += length
                rows.append(values)
        cursor.close()  # finalize RETURNING before commit
        changes = db.total_changes - before
        db.set_authorizer(None)
        db.commit()
        return {'ok': True, 'columns': columns, 'rows': rows, 'shown': len(rows), 'truncated': truncated, 'changes': changes}
    except sqlite3.Error as error:
        db.set_authorizer(None)
        db.rollback()
        # Error text can echo arbitrary SQL values/paths. Safe code plus fixed help.
        return {'ok': False, 'error': getattr(error, 'sqlite_errorname', 'SQL_ERROR')}
    finally:
        db.close()


if __name__ == '__main__':
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (4, 4))
    try:
        request = json.loads(sys.stdin.read(16000))
        result = execute(request['path'], request['sql'])
    except Exception:
        result = {'ok': False, 'error': 'DATABASE_UNAVAILABLE'}
    print(json.dumps(result))
