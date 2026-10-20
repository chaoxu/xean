# Xean v4 TODO

- [ ] Reconstruct every generated note in a proposed solution's transitive
      dependency closure before acceptance, using admitted source results as premises.
      Separate lemma reconstruction from checking whether the final result solves the
      task. Regression: P10 dev3 must not pass solely by assuming n61's unestablished
      classification. Reference: v3.5 `148bb128`, `src/core/math/notes.ts`
      (`pendingChecks` and `refresh`).
