import sqlite3

c = sqlite3.connect(r'c:\tgbotapi\utmanager\state.sqlite')
tables = c.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
for t in tables:
    name = t[0]
    print("TABLE:", name)
    try:
        cols = c.execute(f"PRAGMA table_info({name})").fetchall()
        print("COLS:", [col[1] for col in cols])
        rows = c.execute(f"SELECT * FROM {name} LIMIT 5").fetchall()
        for r in rows:
            print("  ", r)
    except Exception as e:
        print("ERR:", str(e))
