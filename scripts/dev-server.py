"""Local test server on http://localhost:5173 (localhost only).

Serves app/ and, for the local test login only, /.test-users.json.
"""
import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=APP, **k)

    def translate_path(self, path):
        if path.split("?")[0] == "/.test-users.json":
            return os.path.join(ROOT, ".test-users.json")
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


http.server.ThreadingHTTPServer(("127.0.0.1", 5173), Handler).serve_forever()
