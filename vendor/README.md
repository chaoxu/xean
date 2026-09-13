# Pi provider distribution

`pi-ai-0.85.1-elenx.2.tgz` contains the pinned Pi AI 0.85.1 npm package plus the reviewable patch in `patches/`. It preserves failed-response usage, recognizes explicit proxy authentication on custom Codex endpoints, and clears native WebSocket bookkeeping during session cleanup. Pi still owns request conversion, streaming, cached continuation, and transport recovery.

`pi-ai.json` records the original npm integrity and the patch/artifact digests. Run `bun scripts/vendor-pi.ts` to download the pinned original, apply the patch, and verify every packaged file's contents and executable mode. Archive metadata may differ. It executes no package lifecycle scripts or model requests. Change the artifact filename when changing its contents so Bun cannot reuse an older file-dependency cache entry.

The workspace override pins this artifact. Published Elenx packages bundle it with a normal Pi dependency, so consumers need no project-specific patch configuration. Bun can retain a separate transitive Pi copy, so ModelRuntime must bind its Responses provider to the native adapter supplied by Elenx. This keeps streaming and session cleanup in the same module. `scripts/check-package.ts` verifies a fresh-cache installation and a real ModelRuntime request against an offline provider fixture using that binding.
