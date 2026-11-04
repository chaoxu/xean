// Policy extracted without mathematical changes from Xean v1.0.0 (949a385).
import { pick, type Note, type Verification } from "./contracts";
import { noteOrder } from "./support";

/**
 * The longest prefix of the selected verify list whose note and direct
 * dependency texts fit the window, and always its first entry. Texts shared
 * by several notes are read once, so they count once. Transitive dependencies
 * are checked in their own verification work instead of being silently added
 * to this batch's reading budget.
 */
export function verificationPrefix(
  verify: readonly Verification[],
  notes: readonly Note[],
  window: number,
): Verification[] {
  const order = noteOrder(notes);
  const read = new Set<string>();
  let reading = 0;
  let taken = 0;
  for (const entry of verify) {
    const note = pick(notes, entry.note);
    const dependencies = note.support.map((id) => {
      // Validate direct support IDs and publication order even though the
      // window no longer expands through transitive ancestors.
      pick(notes, id);
      if (order(id, note.id) >= 0)
        throw new Error(`support ${id} must precede ${note.id}`);
      return id;
    });
    const added = [note.id, ...dependencies].filter((id) => !read.has(id));
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
