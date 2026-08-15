# Model license notes (primary sources only)

This page records what the distribution pages themselves say about
`zenz-v3.2-small`, `zenz-v3.2-xsmall`, and `Hy-MT2-1.8B`. It is not legal
advice. Quoted text is from the linked files or API responses fetched on
2026-08-16. What those pages do not say is listed as not confirmed.

This repository pins Hy-MT2 GGUF to
`tencent/Hy-MT2-1.8B-GGUF` revision
`1cd5208700acedef4ef93019b6cfc148b8522d45`
(`apps/desktop/src-tauri/src/model_runtime.rs:440`). The zenz verifier
README pins `Miwa-Keita/zenz-v3.2-small-gguf` revision
`c67e03e07d215c869f591b274c1631170d3e11fe`
(`packages/zenz-verifier-rust/README.md:38-39`). Those are the artifacts
checked below.

## 1. zenz-v3.2-small and zenz-v3.2-xsmall

### Distribution pages

- https://huggingface.co/Miwa-Keita/zenz-v3.2-small-gguf
- https://huggingface.co/Miwa-Keita/zenz-v3.2-xsmall-gguf

Hugging Face model API, 2026-08-16:

```json
{"id":"Miwa-Keita/zenz-v3.2-small-gguf","sha":"c67e03e07d215c869f591b274c1631170d3e11fe","cardData":{"license":"apache-2.0"},"tags":["gguf","license:apache-2.0",...],"siblings":[".gitattributes","README.md","ggml-model-Q5_K_M.gguf"]}
```

```json
{"id":"Miwa-Keita/zenz-v3.2-xsmall-gguf","sha":"4f5423f0fad41a73b1242eb96fe5c12ae4fdca83","cardData":{"license":"apache-2.0"},"tags":["license:apache-2.0",...],"siblings":[".gitattributes","README.md","ggml-model-Q5_K_M.gguf"]}
```

`README.md` on both repositories is only the card header. Entire file
contents:

```
---
license: apache-2.0
---
```

(xsmall is the same two lines; 27 bytes vs 31 bytes because of the
model-id length in the fetched copy. The license key is the same.)

### LICENSE file

Not present. Requests to:

- https://huggingface.co/Miwa-Keita/zenz-v3.2-small-gguf/resolve/main/LICENSE
- https://huggingface.co/Miwa-Keita/zenz-v3.2-xsmall-gguf/resolve/main/LICENSE

returned HTTP 404. The sibling lists above also have no `LICENSE` or
`NOTICE` file.

### Base (non-GGUF) repositories

`https://huggingface.co/api/models/Miwa-Keita/zenz-v3.2-small` and
`.../zenz-v3.2-xsmall` returned HTTP 401. Those pages were not read.

### What is not on these pages

- No copyright line
- No NOTICE file
- No extra restriction on commercial use, bundling, or download-only
  distribution
- No statement that GGUF quantization is or is not a modification
- No source-disclosure requirement beyond whatever Apache-2.0 itself
  says (that text is not stored in these repositories)

Older zenz cards (for example `zenz-v3.1-small-gguf`) show
`License: cc-by-sa-4.0` on Hugging Face. That is a different repository.
It is not the license string on the v3.2 GGUF pages above.

## 2. Hy-MT2-1.8B

### Distribution pages

- Weights: https://huggingface.co/tencent/Hy-MT2-1.8B
- GGUF used by this app: https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF

Hugging Face model API, 2026-08-16:

```json
{"id":"tencent/Hy-MT2-1.8B","sha":"9a341cd1b679d3efd23b46e847b01745a71ed792","cardData":{"license":"apache-2.0"},"tags":["license:apache-2.0",...],"siblings":[...,"LICENSE.txt","README.md",...]}
```

```json
{"id":"tencent/Hy-MT2-1.8B-GGUF","sha":"1cd5208700acedef4ef93019b6cfc148b8522d45","cardData":{"base_model":["tencent/Hy-MT2-1.8B"],"license":"apache-2.0"},"tags":["license:apache-2.0",...],"siblings":[...,"LICENSE.txt","README.md",...]}
```

GGUF `README.md` header:

```
---
base_model:
- tencent/Hy-MT2-1.8B
license: apache-2.0
---
```

### LICENSE.txt (GGUF repository)

Fetched from
https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/raw/main/LICENSE.txt
(11,639 bytes). Opening lines:

```
Tencent is pleased to support the open-source community by making Hy-MT2-1.8B-GGUF available.

Copyright (C) 2026 Tencent. All rights reserved.

Hy-MT2-1.8B-GGUF is licensed under the Apache License, Version 2.0.
```

The base-model `LICENSE.txt` is the same Apache-2.0 text with the
product name `Hy-MT2-1.8B` instead of `Hy-MT2-1.8B-GGUF`.

Redistribution conditions from that same file, section 4:

```
4. Redistribution. You may reproduce and distribute copies of the
   Work or Derivative Works thereof in any medium, with or without
   modifications, and in Source or Object form, provided that You
   meet the following conditions:

   (a) You must give any other recipients of the Work or
       Derivative Works a copy of this License; and

   (b) You must cause any modified files to carry prominent notices
       stating that You changed the files; and

   (c) You must retain, in the Source form of any Derivative Works
       that You distribute, all copyright, patent, trademark, and
       attribution notices from the Source form of the Work,
       excluding those notices that do not pertain to any part of
       the Derivative Works; and

   (d) If the Work includes a "NOTICE" text file as part of its
       distribution, then any Derivative Works that You distribute must
       include a readable copy of the attribution notices contained
       within such NOTICE file, ...
```

Copyright grant from the same file, section 2:

```
2. Grant of Copyright License. Subject to the terms and conditions of
   this License, each Contributor hereby grants to You a perpetual,
   worldwide, non-exclusive, no-charge, royalty-free, irrevocable
   copyright license to reproduce, prepare Derivative Works of,
   publicly display, publicly perform, sublicense, and distribute the
   Work and such Derivative Works in Source or Object form.
```

Section 6 (trademarks):

```
6. Trademarks. This License does not grant permission to use the trade
   names, trademarks, service marks, or product names of the Licensor,
   except as required for reasonable and customary use in describing the
   origin of the Work and reproducing the content of the NOTICE file.
```

The GGUF sibling list has `LICENSE.txt` and `README.md`. It does not
list a `NOTICE` file.

## 3. Bundling inside an application

What the pages actually grant:

- Hy-MT2 GGUF: Apache-2.0 section 4 says copies of the Work or
  Derivative Works may be reproduced and distributed “in any medium,
  with or without modifications, and in Source or Object form”, if
  4(a)–(d) are met. Section 2 is a copyright license to distribute.
  There is no extra Tencent term in `LICENSE.txt` that forbids bundling
  in an application, forbids commercial use, or requires publishing
  this app’s source.
- zenz v3.2 GGUF: the only license string on the model card is
  `license: apache-2.0`. The Apache-2.0 text itself is not stored in
  those repositories. Whether Hugging Face’s `license: apache-2.0` tag
  is enough, without a LICENSE file, is **not stated on those pages**.

Conditions that *are* written (Apache-2.0, Hy-MT2 `LICENSE.txt`):

- Give recipients a copy of the License (4(a)).
- If files were modified, mark them as changed (4(b)).
- Keep existing notices in Source form of Derivative Works (4(c)).
- If a NOTICE file exists, copy its attribution notices (4(d)). Hy-MT2
  GGUF has no NOTICE sibling in the API list.
- Trademark names are not licensed except for describing origin
  (section 6).
- The work is “AS IS” (section 7).

Not written on these pages:

- A requirement to open-source the host application
- A ban on commercial use
- A rule that download-at-runtime is treated differently from bundling
- For zenz, a copyright holder line or NOTICE text

## 4. Download-at-runtime versus bundling

None of the fetched files distinguish “ship the weights inside the app”
from “the user downloads the same file later”.

Hy-MT2 `LICENSE.txt` section 4 applies to reproducing and distributing
copies “in any medium”. It does not add a second set of terms for
on-demand download.

zenz cards do not mention either distribution method.

Whether a runtime download still requires giving the user a copy of
Apache-2.0 (because the app then redistributes the file) is **not
answered by these pages**.

## 5. Not confirmed

- Live Hugging Face UI chrome beyond the API `cardData.license` field
  and the raw files above.
- Any license on non-GGUF `Miwa-Keita/zenz-v3.2-small` /
  `zenz-v3.2-xsmall` (HTTP 401).
- Whether the empty zenz README plus `license: apache-2.0` metadata is
  intended as the complete grant, or whether a LICENSE file was omitted
  by mistake.
- Third-party notices that quote these models (for example other apps’
  NOTICE files). Those are not the model authors’ pages.
- Legal effect of any of the above. This page only records the text.
