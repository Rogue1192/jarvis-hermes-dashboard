"""
Double-click entry point.

Idempotent on purpose. Closing the app window does not stop the server -- it is
a browser window, not the program -- so clicking the shortcut again used to
start a second copy, which lost the race for the port and exited without a word.
From the outside that looked like "nothing happens".

Now: if JARVIS is already up, this just reopens the window. If not, it starts him.
Either way, clicking the shortcut gets you a window, which is the only behaviour
anyone actually wants from a shortcut.
"""
import os
import pathlib
import socket
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
os.chdir(pathlib.Path(__file__).resolve().parent)

import server  # noqa: E402  (loads .env, resolves the port)


def running():
    try:
        with socket.create_connection(("127.0.0.1", server.PORT), timeout=0.7):
            return True
    except OSError:
        return False


if running():
    print(f"JARVIS already running on port {server.PORT} - reopening the window.")
    server._open_window()
else:
    server.main()
