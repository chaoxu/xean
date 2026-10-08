export async function cliModels() {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
  });
}
