"""
Averages.io file converter (2026-10-15).

Runs inside the Converter container (src/convert.ts, container/Dockerfile).
One job: a PDF in, a Word document (.docx) out, for turning in a Canva Doc as
Word (Canva's API has no Word export).

  POST /pdf-to-docx   body: the PDF's bytes  ->  200 the .docx's bytes
                      413 too big or too many pages, 422 not a PDF / couldn't convert
  GET  anything       200 "ok" (the container's health check)

Nothing is kept: each conversion uses its own temporary folder, deleted right
after. The conversion runs in a child process with a time limit, so a PDF that
makes pdf2docx hang or eat memory can't take the server down. One conversion at
a time per container; the Worker spreads work over a few containers.
"""

import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
MAX_BYTES = 40 * 1024 * 1024      # same cap as the Worker's MAX_CONVERT_BYTES
MAX_PAGES = 60                    # longer than any Canva Doc a student turns in
TIME_LIMIT_S = 120
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

ONE_AT_A_TIME = threading.Lock()

# The child process: page count check, then pdf2docx. Exit codes: 0 ok, 3 too many pages, 4 failed.
CONVERT = r"""
import sys
src, dst, max_pages = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    import fitz  # PyMuPDF, which pdf2docx uses
    with fitz.open(src) as doc:
        if doc.needs_pass:
            sys.exit(4)
        if doc.page_count > max_pages:
            sys.exit(3)
    import logging
    logging.disable(logging.CRITICAL)
    from pdf2docx import Converter
    cv = Converter(src)
    try:
        cv.convert(dst, multi_processing=False)
    finally:
        cv.close()
except SystemExit:
    raise
except Exception:
    sys.exit(4)
"""


def convert(pdf: bytes):
    """Returns (status, body, content_type)."""
    with tempfile.TemporaryDirectory(prefix="conv-") as tmp:
        src = os.path.join(tmp, "in.pdf")
        dst = os.path.join(tmp, "out.docx")
        with open(src, "wb") as f:
            f.write(pdf)
        try:
            done = subprocess.run(
                [sys.executable, "-c", CONVERT, src, dst, str(MAX_PAGES)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=TIME_LIMIT_S,
                cwd=tmp,
            )
        except subprocess.TimeoutExpired:
            return 422, b'{"error":"convert_failed"}', "application/json"
        if done.returncode == 3:
            return 413, b'{"error":"too_many_pages"}', "application/json"
        if done.returncode != 0 or not os.path.exists(dst):
            return 422, b'{"error":"convert_failed"}', "application/json"
        with open(dst, "rb") as f:
            return 200, f.read(), DOCX_MIME


class Handler(BaseHTTPRequestHandler):
    server_version = "averages-convert"
    sys_version = ""

    def log_message(self, *args):  # no request logs: they'd name nothing useful
        pass

    def send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send(200, b"ok", "text/plain")

    def do_POST(self):
        if self.path != "/pdf-to-docx":
            return self.send(404, b'{"error":"not_found"}', "application/json")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length <= 0:
            return self.send(422, b'{"error":"convert_failed"}', "application/json")
        if length > MAX_BYTES:
            return self.send(413, b'{"error":"file_too_large"}', "application/json")
        pdf = self.rfile.read(length)
        if len(pdf) != length or not pdf.startswith(b"%PDF-"):
            return self.send(422, b'{"error":"convert_failed"}', "application/json")
        with ONE_AT_A_TIME:
            status, body, ctype = convert(pdf)
        self.send(status, body, ctype)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
