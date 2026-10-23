/**
 * Server metadata constants — icon and website URL used in MCP initialize
 * response and .well-known/mcp.json discovery endpoint.
 */

/** Single source of truth for project website URL (also in IDENTITY.WEBSITE_URL). */
export const WEBSITE_URL = "https://github.com/heznpc/Taxi";

/** Static, code-grounded instructions shared by every MCP ingress. */
export const SERVER_INSTRUCTIONS =
  "Taxi exposes local context and actions through the capabilities enabled in this runtime. " +
  "Use discover_tools or start_tool_session to find the capabilities needed for the request. " +
  "A capability call owns its documented target, execution and returned result; it does not " +
  "establish the caller's wider goal. Report partial, stale and uncertain results as such. " +
  "Never blindly retry an outcome_unknown mutation: reconcile its effect first. " +
  "The Node registry applies configured scope, rate-limit, approval and audit policies; " +
  "the emergency stop blocks destructive calls. Approval evidence is not reusable authority. " +
  "Optional generate_plan returns a plan for the caller to review and execute. Native " +
  "Foundation Models agents can autonomously call their restricted read tools. Built-in " +
  "skills execute deterministic steps, including configured event-triggered execution. " +
  "These features do not imply a general-purpose agent loop or an always-on scheduler. " +
  "The native Task Dashboard records Taxi-owned tasks and explicit external-session links. " +
  "Use read_task_dashboard with a tool-session grant to observe them; metadata never grants execution authority. " +
  "A successful invocation alone does not prove the user's task is complete.";

// Taxi roof light above two converging route lanes. Keep this code-native SVG
// visually aligned with the generated raster app icon without embedding a
// second binary asset in every MCP initialize response.
const SERVER_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
<rect width="128" height="128" rx="28" fill="#171B20"/>
<path d="M43 50c2-13 7-20 21-20s19 7 21 20" stroke="#F7C843" stroke-width="7" stroke-linecap="round"/>
<rect x="38" y="45" width="52" height="24" rx="8" fill="#F7C843"/>
<rect x="48" y="51" width="32" height="10" rx="4" fill="#183A43"/>
<path d="M30 103L55 69" stroke="#54D5DD" stroke-width="8" stroke-linecap="round"/>
<path d="M98 103L73 69" stroke="#54D5DD" stroke-width="8" stroke-linecap="round"/>
<path d="M52 103L62 76" stroke="#F7C843" stroke-width="5" stroke-linecap="round"/>
<path d="M76 103L66 76" stroke="#F7C843" stroke-width="5" stroke-linecap="round"/>
</svg>`;

export const SERVER_ICON: { src: string; mimeType: string; sizes: string[] } = {
  src: `data:image/svg+xml;base64,${Buffer.from(SERVER_ICON_SVG).toString("base64")}`,
  mimeType: "image/svg+xml",
  sizes: ["any"],
};
