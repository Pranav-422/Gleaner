import sqlite3

from app import db


def test_backup_runs_once_a_day_and_keeps_the_newest_copies(tmp_path):
    conn = db.db()
    with conn:
        conn.execute("INSERT INTO settings VALUES ('k', 'v')")
    conn.close()
    folder = tmp_path / "backups"
    folder.mkdir()
    for day in range(1, 10):
        (folder / f"gleaner-2020-01-0{day}.db").write_bytes(b"")

    copy = db.backup(keep=3)

    assert db.backup(keep=3) is None  # second call on the same day does nothing
    assert sqlite3.connect(copy).execute("SELECT value FROM settings").fetchone() == ("v",)
    assert sorted(path.name for path in folder.iterdir())[-1] == copy.name
    assert len(list(folder.iterdir())) == 3
