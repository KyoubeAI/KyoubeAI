# Notices

KyoubeAI
Copyright (c) 2026 Hub360+ Technologies Pte. Ltd.

KyoubeAI is source-available software, licensed under the Business Source License 1.1 in `LICENSE`.
In short, you may read, change and redistribute it, use it for evaluation, development and testing
without limit, and run it in production for up to five users, provided you do not offer it to others
as a hosted, managed or embedded service. Any other production use needs a commercial licence
(https://kyoubeai.com/pricing). Four years after each version is published, that version becomes
available under the Apache License, Version 2.0. `LICENSE` is the binding text, and this summary does
not change it.

KyoubeAI is provided "as is", without warranty of any kind; see `LICENSE`.

## Third-party software

### Paperclip

KyoubeAI builds on Paperclip (https://github.com/paperclipai/paperclip), Copyright (c) 2025
Paperclip AI, distributed under the MIT License. The Paperclip image and packages are consumed as
published artifacts; at image build time KyoubeAI applies a branding transform to the image's
user-facing text and artwork (`docker/rebrand/`) and does not otherwise modify them. The MIT
permission notice, reproduced as that licence requires:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Agent harnesses

Since 1.1 the image adds no agent harness of its own. The core image carries Claude Code, Codex, Gemini
CLI, Kimi Code and OpenCode under their own licences, and users install others themselves.
