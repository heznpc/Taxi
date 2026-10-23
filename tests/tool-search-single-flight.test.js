import { describe, test, expect, jest } from "@jest/globals";

let resolveBatch;
const detectProvider = jest.fn(async () => "swift");
const embedBatch = jest.fn(
  () =>
    new Promise((resolve) => {
      resolveBatch = resolve;
    }),
);
const embedText = jest.fn(async () => [1, 0]);
const cosineSimilarity = jest.fn((left, right) => left[0] * right[0] + left[1] * right[1]);

jest.unstable_mockModule("../dist/semantic/embeddings.js", () => ({
  detectProvider,
  embedBatch,
  embedText,
  cosineSimilarity,
}));

const { indexToolDescriptions, reuseToolDescriptionIndex, isToolSearchIndexed, semanticToolSearch } =
  await import("../dist/shared/tool-search.js");

function makeRegistry(tools) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    getToolNames: () => tools.map((tool) => tool.name),
    getToolInfo: (name, options = {}) => {
      const tool = byName.get(name);
      if (!tool) return undefined;
      return {
        name: tool.name,
        title: tool.title,
        description: options.descriptionMode === "summary" ? `summary:${tool.description}` : tool.description,
      };
    },
  };
}

describe("semantic tool index single-flight", () => {
  test("coalesces identical catalog builds and lets HTTP sessions reuse the in-flight index", async () => {
    const tools = [
      { name: "read_note", title: "Read Note", description: "Read one note" },
      { name: "create_note", title: "Create Note", description: "Create one note" },
    ];
    const warmupRegistry = makeRegistry(tools);
    const equivalentRegistry = makeRegistry(tools.map((tool) => ({ ...tool })));
    const sessionRegistry = makeRegistry(tools.map((tool) => ({ ...tool })));

    const warmupBuild = indexToolDescriptions(warmupRegistry);
    const duplicateBuild = indexToolDescriptions(equivalentRegistry);
    await Promise.resolve();
    await Promise.resolve();

    expect(detectProvider).toHaveBeenCalledTimes(1);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(reuseToolDescriptionIndex(warmupRegistry, sessionRegistry)).toBe(true);
    expect(isToolSearchIndexed(sessionRegistry)).toBe(false);

    resolveBatch([
      [1, 0],
      [0, 1],
    ]);
    await expect(warmupBuild).resolves.toBe(2);
    await expect(duplicateBuild).resolves.toBe(2);

    expect(isToolSearchIndexed(warmupRegistry)).toBe(true);
    expect(isToolSearchIndexed(equivalentRegistry)).toBe(true);
    expect(isToolSearchIndexed(sessionRegistry)).toBe(true);
    await expect(semanticToolSearch("read it", 1, 0.5, sessionRegistry)).resolves.toEqual([
      { name: "read_note", title: "Read Note", description: "summary:Read one note" },
    ]);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  test("refuses reuse when a session registry differs from the warmup catalog", async () => {
    const warmupRegistry = makeRegistry([{ name: "read_note", title: "Read Note", description: "Read one note" }]);
    const changedRegistry = makeRegistry([
      { name: "delete_note", title: "Delete Note", description: "Delete one note" },
    ]);
    const warmupBuild = indexToolDescriptions(warmupRegistry);
    await Promise.resolve();
    await Promise.resolve();

    expect(reuseToolDescriptionIndex(warmupRegistry, changedRegistry)).toBe(false);
    expect(isToolSearchIndexed(changedRegistry)).toBe(false);
    resolveBatch([[1, 0]]);
    await warmupBuild;
  });

  test("coalesces a failed embedding build, evicts it, and lets the same catalog retry", async () => {
    const registry = makeRegistry([
      { name: "retry_failed_embedding", title: "Retry", description: "Transient embedding failure" },
    ]);
    const concurrentRegistry = makeRegistry([
      { name: "retry_failed_embedding", title: "Retry", description: "Transient embedding failure" },
    ]);
    const callsBefore = embedBatch.mock.calls.length;
    embedBatch.mockRejectedValueOnce(new Error("transient Swift failure"));

    const failedBuild = indexToolDescriptions(registry);
    const coalescedFailure = indexToolDescriptions(concurrentRegistry);
    await expect(failedBuild).resolves.toBe(0);
    await expect(coalescedFailure).resolves.toBe(0);
    expect(embedBatch).toHaveBeenCalledTimes(callsBefore + 1);
    expect(isToolSearchIndexed(registry)).toBe(false);
    expect(isToolSearchIndexed(concurrentRegistry)).toBe(false);

    embedBatch.mockResolvedValueOnce([[1, 0]]);
    await expect(indexToolDescriptions(registry)).resolves.toBe(1);
    expect(embedBatch).toHaveBeenCalledTimes(callsBefore + 2);
    expect(isToolSearchIndexed(registry)).toBe(true);
    expect(isToolSearchIndexed(concurrentRegistry)).toBe(true);
  });

  test("evicts a provider-none result so later provider availability can retry", async () => {
    const registry = makeRegistry([
      { name: "retry_missing_provider", title: "Retry Provider", description: "Provider becomes available" },
    ]);
    const providerCallsBefore = detectProvider.mock.calls.length;
    const batchCallsBefore = embedBatch.mock.calls.length;
    detectProvider.mockResolvedValueOnce("none");

    await expect(indexToolDescriptions(registry)).resolves.toBe(0);
    expect(isToolSearchIndexed(registry)).toBe(false);
    expect(embedBatch).toHaveBeenCalledTimes(batchCallsBefore);

    embedBatch.mockResolvedValueOnce([[1, 0]]);
    await expect(indexToolDescriptions(registry)).resolves.toBe(1);
    expect(detectProvider).toHaveBeenCalledTimes(providerCallsBefore + 2);
    expect(embedBatch).toHaveBeenCalledTimes(batchCallsBefore + 1);
    expect(isToolSearchIndexed(registry)).toBe(true);
  });

  test("evicts a malformed or partial embedding batch instead of caching false readiness", async () => {
    const tools = [
      { name: "first_partial_tool", title: "First", description: "First vector" },
      { name: "second_partial_tool", title: "Second", description: "Second vector" },
    ];
    const registry = makeRegistry(tools);
    const batchCallsBefore = embedBatch.mock.calls.length;
    embedBatch.mockResolvedValueOnce([[1, 0]]);

    await expect(indexToolDescriptions(registry)).resolves.toBe(0);
    expect(isToolSearchIndexed(registry)).toBe(false);

    embedBatch.mockResolvedValueOnce([
      [1, 0],
      [0, 1],
    ]);
    await expect(indexToolDescriptions(registry)).resolves.toBe(2);
    expect(embedBatch).toHaveBeenCalledTimes(batchCallsBefore + 2);
    expect(isToolSearchIndexed(registry)).toBe(true);
  });

  test("bounds completed process catalog sharing and evicts least-recently-used entries", async () => {
    embedBatch.mockImplementation(async (texts) => texts.map(() => [1, 0]));
    const callsBefore = embedBatch.mock.calls.length;
    const catalogs = Array.from({ length: 12 }, (_, index) => [
      {
        name: `bounded_catalog_${index}`,
        title: `Bounded Catalog ${index}`,
        description: `Catalog ${index}`,
      },
    ]);

    for (const tools of catalogs) {
      await expect(indexToolDescriptions(makeRegistry(tools))).resolves.toBe(1);
    }
    expect(embedBatch).toHaveBeenCalledTimes(callsBefore + catalogs.length);

    // The newest catalog remains shared, while the oldest of twelve has been
    // evicted from the eight-entry process map and must build once more.
    await expect(indexToolDescriptions(makeRegistry(catalogs.at(-1)))).resolves.toBe(1);
    expect(embedBatch).toHaveBeenCalledTimes(callsBefore + catalogs.length);
    await expect(indexToolDescriptions(makeRegistry(catalogs[0]))).resolves.toBe(1);
    expect(embedBatch).toHaveBeenCalledTimes(callsBefore + catalogs.length + 1);
  });
});
