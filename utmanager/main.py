# main.py
from __future__ import annotations
import asyncio
from telegram import Update
from utmanager.app import build_app
from utmanager.preflight import preflight_check

def _ensure_loop_if_needed():
    try:
        asyncio.get_running_loop()
        return None
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop

def main():
    asyncio.run(preflight_check())
    app = build_app()

    try:
        import inspect
        if inspect.iscoroutinefunction(app.run_polling):
            asyncio.run(app.run_polling(allowed_updates=Update.ALL_TYPES))
        else:
            created = _ensure_loop_if_needed()
            try:
                app.run_polling(allowed_updates=Update.ALL_TYPES)
            finally:
                if created is not None:
                    created.close()
    except TypeError:
        created = _ensure_loop_if_needed()
        try:
            app.run_polling(allowed_updates=Update.ALL_TYPES)
        finally:
            if created is not None:
                created.close()

if __name__ == "__main__":
    main()
