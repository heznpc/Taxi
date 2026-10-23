/** Bounded extraction only; raw provider output remains the canonical artifact. */
export function normalizeProviderOutput(raw: string) {
  const messages: string[] = [];
  let malformedLines = 0;
  let providerReportedError = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.type === "item.completed" && row.item?.type === "agent_message" && typeof row.item.text === "string")
        messages.push(row.item.text);
      if (row.type === "assistant" && Array.isArray(row.message?.content)) {
        for (const block of row.message.content)
          if (block.type === "text" && typeof block.text === "string") messages.push(block.text);
      }
      if (row.type === "result") {
        if (!messages.length && typeof row.result === "string") messages.push(row.result);
        if (row.is_error === true) providerReportedError = true;
      }
      if (row.type === "turn.failed" || row.type === "error") providerReportedError = true;
    } catch {
      malformedLines++;
    }
  }
  return { text: messages.join("\n\n"), malformedLines, providerReportedError };
}
