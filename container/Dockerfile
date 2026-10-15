# Averages.io file converter (src/convert.ts): PDF to Word for the type pill.
# Built and deployed by `wrangler deploy` (wrangler.jsonc "containers"); Workers
# Builds can build it too. Python's standard library serves HTTP; pdf2docx (with
# PyMuPDF) does the conversion. Versions are pinned so a rebuild doesn't change it.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install pdf2docx==0.5.8 PyMuPDF==1.24.14 opencv-python-headless==4.10.0.84 numpy==2.1.3

COPY server.py /app/server.py

# Not root, and nothing to write but its own temporary folders.
RUN useradd --system --no-create-home --shell /usr/sbin/nologin convert
USER convert
WORKDIR /tmp

EXPOSE 8080
CMD ["python", "/app/server.py"]
