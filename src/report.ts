import {
  UsageDoc,
  type ConversationId,
  type Cursor,
  type Tx,
  type UsageState,
} from "@earendil-works/pi-durable";
import { definition, Notebook, project } from "./state.ts";
import type { Note } from "./policy/contracts.ts";
import { byId, supportClosure } from "./policy/support.ts";

import {
  campaignKind,
  type CampaignResult,
  type CampaignState,
} from "./workflow.ts";

/** Status comes from the latest native campaign task, not a second run table. */
export async function readStatus(tx: Tx, root: ConversationId) {
  const page = await tx.scanTasks(
    { conversationId: root, kind: campaignKind, order: "descending" },
    1,
  );
  const campaign = page.items[0];
  if (!campaign) throw new Error("Campaign task is missing");
  const state = campaign.state;
  const result = state.outcome?.result as CampaignResult | undefined;
  const checkpoint = state.checkpoint as CampaignState | undefined;
  return {
    taskId: campaign.id,
    status: state.status,
    outcome:
      result?.outcome ?? (state.outcome ? state.outcome.status : "running"),
    turns: result?.turns ?? checkpoint?.turns ?? 0,
    accepted: result?.accepted ?? null,
    error:
      result?.error ??
      state.outcome?.error?.message ??
      state.outcome?.reason ??
      null,
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
  return JSON.parse(JSON.stringify(conversations)) as typeof conversations;
}

export async function readReport(tx: Tx, root: ConversationId) {
  const value = await definition(tx, root);
  const status = await readStatus(tx, root);
  const notebook = await tx.doc(Notebook, root);
  // Detach Pi's transaction overlays before the read-only Session closes.
  const result = {
    ...value,
    status,
    ...project(notebook),
    checks: notebook.checks,
    guidance: notebook.guidance,
    inputs: notebook.inputs,
    usage: await readUsage(tx),
  };
  return JSON.parse(JSON.stringify(result)) as typeof result;
}

/** Append-only support makes the accepted argument stable after its terminal result. */
export async function acceptedArgument(
  notes: Note[],
  candidateId: string,
): Promise<string> {
  const candidate = notes.find((note) => note.id === candidateId);
  if (!candidate) throw new Error("Accepted candidate is missing");
  const ids = [...(await supportClosure([candidate], notes)), candidateId].sort(
    byId,
  );
  return ids
    .map((id) => {
      const note = notes.find((item) => item.id === id)!;
      return `## ${note.id}\n\n${note.summary ? note.summary + "\n\n" : ""}${note.text}\n`;
    })
    .join("\n");
}
