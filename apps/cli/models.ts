export async function cliModels() {
  // Use the pinned module directly to avoid loading Pi's interactive exports.
  const { ModelRuntime } = await import(
    new URL(
      "./core/model-runtime.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href
  );
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  const error = models.getError();
  if (error) throw new Error(error);
  return models;
}
