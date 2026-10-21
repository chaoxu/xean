// Policy extracted without mathematical changes from Xean v1.0.0 (949a385).
import { pick, type Note, type Verification } from "./contracts";
import { byId, supportClosure } from "./support";

/**
 * The longest prefix of the coordinator's verify list whose note and support
 * texts fit the window, and always its first entry. Texts shared by several
 * notes are read once, so they count once.
 */
export function verificationPrefix(
  verify: readonly Verification[],
  notes: readonly Note[],
  window: number,
): Verification[] {
  const read = new Set<string>();
  let reading = 0;
  let taken = 0;
  for (const entry of verify) {
    const note = pick(notes, entry.note);
    // The first closure validates all known IDs, including disconnected notes.
    const closed =
      taken > 0 &&
      note.support.every((id) => read.has(id) && byId(id, note.id) < 0);
    const added = [
      note.id,
      ...(closed ? [] : supportClosure([note], notes)),
    ].filter((id) => !read.has(id));
    const cost = added.reduce(
      (sum, id) => sum + pick(notes, id).text.length,
      0,
    );
    if (taken > 0 && reading + cost > window) break;
    for (const id of added) read.add(id);
    reading += cost;
    taken += 1;
  }
  return verify.slice(0, taken);
}
