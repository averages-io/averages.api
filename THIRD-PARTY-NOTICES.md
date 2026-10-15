# Third-party notices

The Averages.io API is GPL-3.0 (see `LICENSE`). It includes, or runs alongside,
the third-party software below, each used under its own license.

Two parts are covered:

1. **The Worker** (`src/`): npm packages bundled into the deployed Worker.
2. **The file converter container** (`container/`, 2026-10-15): Python packages
   installed into its image. Each package's own license file is also inside
   the image, in its `site-packages/<name>.dist-info/` folder.

---

## 1. The Worker

| Package | Version | License | Copyright |
|---|---|---|---|
| [hono](https://github.com/honojs/hono) | ^4.6 | MIT | Copyright (c) 2021 - present, Yusuke Wada and Hono contributors |
| [@cloudflare/containers](https://github.com/cloudflare/containers) | 0.3.7 | MIT OR Apache-2.0 (used under MIT) | Copyright (c) Cloudflare, Inc. |

---

## 2. The file converter container

Built from `container/Dockerfile` on the official `python:3.12-slim` image
(Python is under the [PSF License](https://docs.python.org/3/license.html);
the Debian base packages are under their own free software licenses, listed
in the image at `/usr/share/doc/*/copyright`).

| Package | Version | License | Copyright |
|---|---|---|---|
| [pdf2docx](https://github.com/ArtifexSoftware/pdf2docx) | 0.5.8 | GPL-3.0 | Copyright (c) Artifex Software, Inc. |
| [PyMuPDF](https://github.com/pymupdf/pymupdf) (includes MuPDF) | 1.24.14 | AGPL-3.0 | Copyright (c) Artifex Software, Inc. |
| [opencv-python-headless](https://github.com/opencv/opencv-python) | 4.10.0.84 | Apache-2.0 (OpenCV and its bundled libraries: see `LICENSE-3RD-PARTY.txt` in the package) | Copyright (c) OpenCV team |
| [NumPy](https://github.com/numpy/numpy) | 2.1.3 | BSD-3-Clause | Copyright (c) 2005-2024, NumPy Developers |
| [python-docx](https://github.com/python-openxml/python-docx) | 1.2.0 | MIT | Copyright (c) 2013 Steve Canny |
| [fontTools](https://github.com/fonttools/fonttools) | 4.67.0 | MIT | Copyright (c) 2017 Just van Rossum |
| [lxml](https://github.com/lxml/lxml) | 6.1.3 | BSD-3-Clause | Copyright (c) 2004 Infrae |
| [Python Fire](https://github.com/google/python-fire) | 0.7.1 | Apache-2.0 | Copyright 2017 Google Inc. |
| [termcolor](https://github.com/termcolor/termcolor) | 3.3.0 | MIT | Copyright (c) 2008-2011 Volvox Development Team |
| [typing_extensions](https://github.com/python/typing_extensions) | 4.16.0 | PSF-2.0 | Copyright (c) Python Software Foundation |

pdf2docx, PyMuPDF and NumPy are pinned in the Dockerfile; the others are what
pip installed for them on 2026-10-15 and can move to newer versions on a
rebuild.

### About the GPL and AGPL parts

- **pdf2docx (GPL-3.0)** and **PyMuPDF (AGPL-3.0)** are used unmodified. The
  API's own license, GPL-3.0, is compatible with both.
- **AGPL-3.0, section 13:** people who use the converter over the network
  (students turning in a Canva Doc as Word) must be able to get its source.
  The converter's source is `container/` in this repository, and the two
  libraries' sources are at the links above (PyMuPDF 1.24.14:
  https://github.com/pymupdf/PyMuPDF/tree/1.24.14, pdf2docx 0.5.8:
  https://github.com/ArtifexSoftware/pdf2docx/tree/v0.5.8). Keep this
  repository published while the converter runs, and link it from the
  website (the privacy policy's converter section does).
- Full texts: GPL-3.0 is in `LICENSE`; AGPL-3.0 is at
  https://www.gnu.org/licenses/agpl-3.0.txt and inside the image in
  PyMuPDF's `dist-info` folder.

---

## License texts

### MIT License (hono, @cloudflare/containers, python-docx, fontTools, termcolor)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### BSD 3-Clause License (NumPy, lxml)

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### Apache License 2.0 (opencv-python-headless, Python Fire)

Full text: https://www.apache.org/licenses/LICENSE-2.0.txt (also inside the
image in each package's `dist-info` folder).

### PSF License 2.0 (Python, typing_extensions)

Full text: https://docs.python.org/3/license.html
