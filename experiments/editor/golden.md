# Editor golden dataset

This fixture uses the exact original notes `w899-1/n1`, `w899-1/n2`, and `w899-1/n8`. They form a closed, coherent module on finite-state sign compression and guarded conformal progress. Their full bodies total **5,663 reference tokens**. No excerpting or adapted proof is needed.

The source is `/Users/chaoxu/playground/xean/runs/editor-economics-20260928-r01/source-snapshot.json`, the frozen 289-note snapshot. Its SHA-256 is `f33bb0df0832aed1d0276c161a47be7aa33b6fa0e94e119356896c67068af201`. The exact selected objects are extracted into input.json. Its only schema adaptation is detailedSummary=summary, because the historical snapshot predates that required field. Full text, IDs, support, checks, and all other original fields are unchanged. The task removes the historical claim that additional imported lemmas are supplied. The mathematical target and completion criteria are unchanged. The experiment runtime reads input.json without opening the large source snapshot.

| Exact ID    | Content                                                                                   | Full-text characters / UTF-8 bytes | Reference tokens | Declared support |
| ----------- | ----------------------------------------------------------------------------------------- | ---------------------------------: | ---------------: | ---------------- |
| `w899-1/n1` | Scaled affine-margin learner with a bounded dead-zone statistic                           |                              4,666 |            1,256 | None             |
| `w899-1/n2` | Exact zero restoration and determinant-size compression from finite-state labels          |                              8,265 |            2,078 | None             |
| `w899-1/n8` | Quantized-hull conformal ray algorithm, horizontal outputs, and a nonuniversality example |                              9,418 |            2,329 | `w899-1/n2`      |
| Total       |                                                                                           |                             22,349 |            5,663 | Complete closure |

Counts use cached `tiktoken` 1.0.22 with `o200k_base`, run locally under Fleet's locked Bun. They count full note bodies separately and exclude summaries, checks, task text, and prompt framing. They are reference counts rather than provider billing counts. The serialized adapted task adds 682 reference tokens.

All three notes have recorded correctness PASS and source PASS, with no external premises. These are preserved historical checks. This selection review read all three proofs but does not constitute a new independent mathematical certification.

Full-text SHA-256 values:

- `w899-1/n1`: `e1be6e0133fbd9b3db9556a2f925f06ab1a5434b2314508c6330af393969beb9`
- `w899-1/n2`: `692af671e22a86a6d264ae66316d5bd31c38222e8b479f68ab7d61abcf80d279`
- `w899-1/n8`: `225d8c684222736638a23b784e590429bca3569d46b99450de38fc139e57b174`

The source text of n2 mentions that n1 can supply its semantic promise, then explicitly proves n2 without using n1. The declared closure is therefore accurate. The source uses local references such as “n2”, which resolve within the selected `w899-1` group.

## Why this subset

The three notes share one implemented dynamic program over signed coordinate moves. Both compression and ray extraction use short-row span discovery and a rank-increasing vertex walk. The long proofs repeat the finite-state setup, endpoint reasoning, parametric boundary search, and rational-workspace accounting. An Editor can consolidate that machinery while preserving the differences between exact sign compression and closed-conformal progress.

This is a useful test of the failure seen in the large trial. The learner depends on distinguishing the integer numerator `p` from the scaled iterate `c=p/K`. The ray algorithm depends on strict projection tests and on a guard for the numerical radius. Its counterexample prevents the positive branch from being advertised as a universal algorithm.

The material comes from an actual research run and includes the original technical proofs and limitations. It needs no synthetic duplicate notes or simplified examples.

## Useful content and removable repetition

Preserve the usable mathematical capabilities below, with proofs or valid declared dependencies. Shared arguments may move into one lemma, statements may be combined, and intermediate notation may disappear. The expected result has no prescribed note count, organization, wording, or compression ratio.

- Keep the learner's success and sound-failure guarantees, including exact zero labels and its numerical parameter dependence.
- Keep exact three-sign recovery from a finite-state statistic, with an implemented boundary search and the determinant bound.
- Keep the guarded objective-positive integer ray construction, its checkable conditions, and its distinction from a final sign representative.
- Keep the geometric obstruction and the unresolved uniformity gap. The horizontal-output application should remain available as a consequence of the general construction.
- Consolidate repeated DP transitions, endpoint witnesses, span growth, nullspace calculations, right-hand-germ comparisons, and encoding arguments when the merged statement covers every use.
- Remove repeated motivation, duplicated status prose, and intermediate lemmas whose mathematical use is fully covered by the replacement proof.

The fixture task makes the supplied material accurate by replacing the historical sentence beginning with the prior coarse bound and its following availability sentence. The replacement is: `A prior construction achieves $O(d^2+d\log N)$ bits. Any valid mathematical approach is allowed.` The deleted text claimed that supporting lemmas were supplied as imported notes and available as starting material. The exact mathematical target and completionCriteria are preserved. The ordinary proof and evidence requirements apply to any other result used. The answer key adds no hidden proof restriction.

## Mathematical answer key

Judge the replacement corpus as a whole. The following capabilities and boundaries are the answer key. Equivalent statements, different valid proofs, and stronger results are acceptable. Exact numerical constants may change when the replacement proves compatible bounds.

**Scaled learner and exact labels.** For integer `W`, integer radius `H>=1`, and integer budget `P>=1`, set `K=2H²` and use labels `s(x,b)=sgn(2Wᵀx+b)` for `||x||₁<=H` and `b=±1`. The source maintains `c=p/K` and updates `p←p+s(x,b)x`, so the step in `c` is `s(x,b)x/K`. A height-`P` integer sign representative gives target `c*=2v`. Each violated affine constraint decreases squared distance by more than `1/(4H²)`, yielding the `16dP²H²` update bound. Successful termination gives positive values at least `3K/2`, negative values at most `−3K/2`, and zero-labelled values within `K/2`. Failure rules out the stated bounded-height promise. The statistic alone is not an exact-zero-preserving answer.

**Exact finite-state compression.** Given integer `p,W` and integer threshold `K>=1` with the exact labels positive iff `pᵀx>=K`, negative iff `pᵀx<=−K`, and zero otherwise, the method constructs integer `q` preserving all three signs on the complete radius-`H` ball. Its height is at most `dH^(d−1)`. Dynamic programming covers all signed coordinate paths of at most `H` moves, including cancellations, zero coordinates, and every required endpoint. It finds the exact zero span, then an active vertex using at most `d` rank increases. Exact one-dimensional parametric comparisons find the first boundary without precision-dependent bisection, including zero-length moves. Work is polynomial in `d,H,||p||∞+1,log(K+1)`, and rational intermediate lengths are polynomial in the total encoded input length.

**Guarded conformal progress.** Normalize nonzero `w` to `a=w/||w||∞`, choose integers `B>=1` and `L>=H`, round `Ba` to integer `p`, and let `E` be the span of actual short rows with `|pᵀx|<=L`, where `L>=H`. Write `r=proj_E a` and `q=a−r`. The source tests `H||r||∞ < (L+1−H/2)/B` and `hᵀq>0`. Passing tests allow an implemented walk to produce integer `u` with `hᵀu>0`, `||u||∞<=H^(d−1)`, preservation of original zeros, and weak agreement with every original nonzero sign. The section's normalizing row `c` is excluded from the cofactor bound. Work is polynomial in `d,H,B`, and only `H<=L<B` need be tried. For a unit-anchor input `(W,1)` with `||W||∞>2B`, the anchor rounds to zero and every output has zero anchor. A suitable objective certifies escape from a supplied ordinary-coordinate span. Such a horizontal ray is progress, not the final representative.

**Scoped obstruction.** At `H=4`, take `w_i=(5/2)^i`. Required tests force every nonzero integer closed-conformal vector to satisfy `u_i>=0` and `2u_i<=u_(i+1)<=3u_i`, hence `u_0>=1` and `u_(d−1)>=2^(d−1)`. If `B(2/5)^(d−1)<1/2`, quantization sets `p_0=0`, putting `e_0` in every band hull and forcing any proposed output to have `u_0=0`. Thus no threshold can pass the success tests for polynomial `B` at sufficiently large dimension. The input nevertheless has an `O(d)`-bit integer representative by clearing powers-of-two denominators. The obstruction applies to this quantized-hull branch.

**Remaining gap.** These constructions do not establish the unrestricted `poly(d,log N)` algorithm. Finite-state work depends on numerical `H` and statistic height, the learner depends on numerical `P`, and the guarded ray branch can fail. Rational workspace is bounded in total input encoding length, while operation counts are independent of the magnitude and precision of the original real data. Those distinct guarantees must remain distinct.

## Focused failure checks

These are concrete mathematical regressions for reviewing an output, rather than requirements to reproduce source phrasing:

- A claimed descent for unscaled `p` toward `2v` is false. Take `d=1`, `W=v=1`, `H>=5`, `p=0`, and violating pair `x=H,b=−1`. Updating to `p=H` increases its squared distance to 2.
- Deleting zero-labelled rows or treating the dead-zone statistic as the final representative loses exact zeros.
- A boundary search whose iterations depend on input precision loses the stated arithmetic-operation guarantee.
- A conformal ray may have zero pairing with an originally positive row. Promoting weak conformity to exact three-sign preservation requires another argument.
- Discarding the geometric example or claiming universal success after a polynomial choice of `B` loses the source's established limitation.

The answer key belongs in the evaluation material. It need not be injected into the Editor's initial prompt. The Editor can receive the small original corpus, the task context, and the ordinary instruction to simplify useful mathematical memory.

## Frozen input and manual check

Input: `input.json`, SHA-256 `bc5d5b4c2a480b081a5396d5a7bd29dc31925785c092884c56173b6bc2b4802b`. The complete formatted JSON occupies 30190 UTF-8 bytes and 7511 o200k_base reference tokens, including task, summaries, and historical checks.

Manual inspection checked the actual source arguments for scaled descent, completeness of signed-coordinate paths, symmetry of the zero band, coordinate constraints guaranteeing a finite boundary, rank growth at a zero-length step, exact right-hand-germ comparison, exclusion of the section row from ray cofactors, horizontal anchor annihilation, and the geometric nonuniversality proof. No concrete defect was found in those essentials. No model call was made. Historical checks remain historical checks.

Keep this file out of generation context. An independent reviewer may use it after generation to judge mathematical capabilities and scoped limitations.
