# File converter container

Turns a PDF into a Word document (.docx) for the type pill's **Word** choice on Canva Docs. Canva's API can export PDF, PowerPoint and PNG, but not Word, so Averages.io asks Canva for a PDF and converts it here. Code on the Worker side: `src/convert.ts`. Wired into Canva exports in `src/canvaExport.ts`.

- `server.py`: a small HTTP server on port 8080. `POST /pdf-to-docx` takes the PDF and answers with the .docx. Any GET answers `ok`.
- `Dockerfile`: Python 3.12 with pdf2docx and PyMuPDF, pinned versions. It runs as a non-root user.
- Nothing is stored. Each file lives in a temporary folder only while it's converted, then the folder is deleted. The container has no internet access (`enableInternet = false`).
- Limits: 40 MB and 60 pages per PDF, and 2 minutes per conversion. One conversion at a time per container, spread over up to 3 containers (`max_instances`).

## Deploying

`npx wrangler deploy` builds this Dockerfile and pushes the image, which needs Docker running on the machine. Cloudflare's Git deploys (Workers Builds) can build it too. Containers need the Workers Paid plan.

To turn Word off without a redeploy of the code, set `CONVERT_ENABLED` to `"0"` in wrangler.jsonc and deploy. The app then stops offering Word.

## Trying it by hand

```sh
docker build -t averages-convert container
docker run --rm -p 8080:8080 averages-convert
curl -X POST --data-binary @some.pdf http://localhost:8080/pdf-to-docx -o out.docx
```

## Licenses

pdf2docx is GPL-3.0 and PyMuPDF is AGPL-3.0. The API itself is GPL-3.0, so the licenses fit. AGPL also covers software used over a network: the source of this container (these files, unchanged libraries) has to be available to the people it serves. Keep it published, for example in a public copy of this repository, and list both libraries in the API's third-party notices.
