import { ChromeSession } from "../browser/structured.js";
export async function runBrowser(args = process.argv.slice(3)) {
  const [action, endpoint, targetId, url, selector] = args;
  if (!endpoint || !targetId || !url || !["observe", "click"].includes(action ?? ""))
    throw new Error("Usage: taxi browser observe/click <loopback CDP URL> <target ID> <exact page URL> [CSS selector]");
  const session = await ChromeSession.connect(endpoint, targetId, url);
  try {
    console.log(
      JSON.stringify(action === "click" ? await session.click(selector ?? "") : await session.observe(), null, 2),
    );
  } finally {
    session.close();
  }
}
