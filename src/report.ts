import {
  UsageDoc,
  type ConversationId,
  type Cursor,
  type Session,
  type Tx,
  type UsageState,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { definition, project, readNotebook } from "./state.ts";
import { copy, type ResearchData } from "./records.ts";
import { pick, type Note } from "./policy/contracts.ts";
import { noteOrder, supportClosure } from "./policy/support.ts";
import { turns } from "./workflow.ts";

export function readNotes(data: ResearchData) {
  return project(readNotebook(data.notebook)).notes;
}

/** Campaign state and settled worker history are authoritative in Chord. */
export function readStatus(data: ResearchData) {
  const campaign = data.campaign;
  if (!campaign) throw new Error("Campaign is not initialized");
  return {
    status: campaign.status,
    outcome: campaign.outcome ?? "running",
    turns: turns(data),
    accepted: campaign.accepted ?? null,
    error: campaign.error ?? null,
  };
}

/** Report Pi's native per-conversation ledgers without inventing request counts. */
export async function readUsage(tx: Tx) {
  const conversations: ({ conversationId: ConversationId } & UsageState)[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 128, cursor);
    for (const conversation of page.items) {
      const usage = await tx.doc(UsageDoc, conversation.id);
      if (Object.keys(usage.models).length || Object.keys(usage.tools).length)
        conversations.push({ conversationId: conversation.id, ...usage });
    }
    cursor = page.next;
  } while (cursor);
  return copy(conversations);
}

export async function readReport(data: ResearchData, session: Session) {
  const notebook = readNotebook(data.notebook);
  return copy({
    ...definition(data),
    status: readStatus(data),
    ...project(notebook),
    checks: notebook.checks,
    guidance: notebook.guidance,
    inputs: notebook.inputs,
    sources: data.sources,
    usage: await session.commit(readUsage, context),
  });
}

/** Append-only support makes the accepted argument stable after its terminal result. */
export function acceptedArgument(notes: Note[], candidateId: string): string {
  const candidate = notes.find((note) => note.id === candidateId);
  if (!candidate) throw new Error("Accepted candidate is missing");
  const ids = [...supportClosure([candidate], notes), candidateId].sort(
    noteOrder(notes),
  );
  return ids.map((id) => `## ${id}\n\n${pick(notes, id).text}\n`).join("\n");
}
