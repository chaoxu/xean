import {
  createCampaign,
  defineTool,
  deriveCandidateStatus,
  entryIdSchema,
  openCampaign,
  returnedToolSubmission,
  type CallReceipt,
  type Campaign,
  type RecordQuery,
} from "elenx";
import {
  builtinPi,
  derivePiSpend,
  InMemoryCredentialStore,
  runPi,
} from "elenx/pi";
import { z } from "zod";

declare const campaign: Campaign;
const models = builtinPi();
const credentialModels = builtinPi({
  credentials: new InMemoryCredentialStore(),
});
const model = models.getModel("provider", "model");

const tool = defineTool({
  name: "read",
  description: "Read one value",
  input: z.strictObject({ key: z.string() }),
  replay: "safe",
  async run({ key }) {
    return { key };
  },
});

const result =
  model === undefined
    ? undefined
    : runPi(campaign, {
        models,
        model,
        label: "audit/v1",
        prompt: "audit",
        reasoning: "max",
        tools: [tool],
      });

void createCampaign;
void openCampaign;
void entryIdSchema.parse(1);
void deriveCandidateStatus(campaign.records(), 1);
void derivePiSpend(campaign.records());
void returnedToolSubmission;
void (undefined as unknown as CallReceipt);
void result;
void credentialModels;
const query: RecordQuery = {
  kinds: ["tool-call"],
  call: 1,
  through: campaign.lastSequence(),
};
void campaign.records(query);
void campaign.record(1);
void campaign.payload(campaign.storePayload({ input: [] }));
