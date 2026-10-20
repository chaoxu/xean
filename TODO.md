# Xean release qualification

- [x] Implement joint reconstruction of eligible solution roots and their generated
      dependency closure, using admitted verified source dependencies as premises.
      Acceptance requires reconstruction PASS throughout that closure in the
      root's accepting attempt. Supporting lemmas need not satisfy the final task's
      requirements. Scripted regressions cover missing dependency proofs, shared
      ancestors, source leaves, corrections, and atomic verdicts.
- [x] Implement and test `verifyOnSolution` and `init --verify-on-solution`,
      preserving default verification timing and checking candidate selection,
      dependency verification, and return to exploration.
- [ ] Qualify the policy on P10 dev3's unestablished classification in n61 with a
      fresh mathematical run. Reference: v3.5 `148bb128`, `src/core/math/notes.ts`
      (`pendingChecks` and `refresh`).
- [x] Exercise live Codex discovery and primary-paper retrieval on Forni's
      Lemma 3.5, distinguishing its exact attribution from omitted conservativity.
- [x] Exercise applicability of the admitted Forni premise with vector fields
      that do and do not preserve a positive smooth invariant volume.
- [ ] Qualify source judgments across further results and retrieval failures,
      including exact hypotheses and conventions.
- [ ] Independently review fresh mathematical outputs under the joint
      reconstruction policy. Keep the earlier `b9ee726` benchmark separate.
