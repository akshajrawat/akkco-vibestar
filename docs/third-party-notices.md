# Third-party notices

Project code uses the root [MIT License](../LICENSE), with the requested notice
`Copyright (c) 2026 akkco`. This notice does not replace third-party licenses or
change historical author attribution.

Bundled `src/assets/fonts/Geist-Sans.woff2` and `Geist-Mono.woff2` retain the SIL Open
Font License 1.1 and the Vercel/basement.studio copyright notice in
[`public/Geist-OFL.txt`](../public/Geist-OFL.txt). Vite copies that notice into `dist`.
Do not remove it from packaged renderer assets.

Runtime/development dependencies, Electron and native addons retain their own
licenses/notices in the installed packages. Packaging must preserve the applicable
notices and Electron license resources. The project MIT license does not relicense them.

The repository history and tracked assets were inspected before adding the root
license. The recorded source history has one author, Akshaj Rawat; app icons originate
in that history. No conflicting source/asset notice was found. This is an inventory
of available evidence, not a claim that a root license changes ownership of copied material.
New third-party assets or vendored code need explicit provenance and retained notices.

The root text follows the [standard MIT License](https://opensource.org/license/mit).

## Provider and GitHub marks

The provider SVGs in `src/assets/brands/` were supplied for this milestone and
verified against [Lobe Icons](https://github.com/lobehub/lobe-icons/tree/master/packages/static-svg/icons):
`openai.svg`, `claude-color.svg` (stored as `anthropic.svg`), `gemini-color.svg`
(stored as `gemini.svg`), `antigravity-color.svg` (stored as `antigravity.svg`), and `github.svg`. Their MIT license is retained below
and in `src/assets/brands/LICENSE`. This notice is included in desktop packaging.

Brand names and marks belong to OpenAI, Anthropic, Google and GitHub respectively.
They identify the actual tool or reported model; inclusion does not imply endorsement.
Antigravity retains its product identity, with the Gemini mark used only for a
Gemini model. Claude assets do not add a connected Claude provider.

```text
MIT License

Copyright (c) 2023 LobeHub

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

## T3 Code chat presentation

Chat layout, composer transition and timeline behavior were adapted from
[pingdotgg/t3code](https://github.com/pingdotgg/t3code), commit
`861a51a6c4a036a6f14fea2a6f093808de1d96ce`. The MIT notice follows.

```text
MIT License

Copyright (c) 2026 T3 Tools Inc.

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
