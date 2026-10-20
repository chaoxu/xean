# Xean v4 TODO

- [x] Implement joint reconstruction of eligible solution roots and their generated
      dependency closure, using admitted verified source dependencies as premises.
      Acceptance requires reconstruction PASS throughout that closure in the
      root's accepting attempt. Supporting lemmas need not satisfy the final task's
      requirements. Scripted regressions cover missing dependency proofs, shared
      ancestors, source leaves, corrections, and atomic verdicts.
- [ ] Qualify the policy on P10 dev3's unestablished classification in n61 with a
      fresh mathematical run. Reference: v3.5 `148bb128`, `src/core/math/notes.ts`
      (`pendingChecks` and `refresh`).
