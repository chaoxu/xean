import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export async function cliModels() {
  // Use the pinned module directly to avoid loading Pi's interactive exports.
  const { AuthStorage } = await import(
    new URL(
      "./core/auth-storage.js",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    ).href
  );
  return builtinModels({ credentials: AuthStorage.create() });
}
