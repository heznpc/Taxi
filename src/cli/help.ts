/** `taxi --help` — canonical Taxi CLI usage. */
import { LOGO_LINES } from "../shared/banner.js";
import { BOLD, DIM, RESET, WHITE, GREEN, CYAN } from "./style.js";

export function runHelp(): void {
  console.log("");
  for (const line of LOGO_LINES) console.log(line);
  console.log("");
  console.log(`  ${BOLD}${WHITE}Taxi${RESET}  ${DIM}Approval-gated local action runtime for Apple workspaces${RESET}`);
  console.log("");
  console.log(`  ${BOLD}Usage${RESET}`);
  console.log("");
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}setup${RESET}            ${DIM}Interactive setup; client connection asks first and defaults to No${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}setup --profile starter --yes${RESET} ${DIM}Non-interactive config only; clients skipped${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}setup --profile starter --yes --clients${RESET} ${DIM}Also configure detected clients (explicit opt-in)${RESET}`,
  );
  console.log("    taxi history --since <ISO> --until <ISO> [--snapshot <path>] [--output <new file>]");
  console.log("    taxi browser observe/click <CDP URL> <target ID> <page URL> [CSS selector]");
  console.log("    taxi remote submit <executor URL> <flow UUID> | reconcile/cancel <request UUID>");
  console.log("    taxi work run <request.json> | show/cancel/recover <id> | review <id> <note-file>");
  console.log("    taxi sessions <Modore snapshot.json>");
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}doctor${RESET}          ${DIM}Diagnose installation${RESET}`);
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}verify${RESET}          ${DIM}Verify local audit integrity and runtime trust state${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}modules${RESET}         ${DIM}Inspect or select bundled module packs${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}workflows${RESET}       ${DIM}Show high-value workflow examples${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}workflows today-overview --prompt${RESET} ${DIM}Print the starter-safe first prompt${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}workflows today-overview --preview${RESET} ${DIM}Local diagnostic; bypasses MCP governance and audit${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}connect${RESET}         ${DIM}Bridge stdio to the running Taxi.app runtime${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}clients${RESET}         ${DIM}Configure or repair MCP client registrations${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}clients --client-runtime direct${RESET} ${DIM}Use pinned-package direct stdio configs${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}codex disable${RESET}   ${DIM}Disable Taxi at Codex startup without deleting its config${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}repo --root${RESET} PATH ${DIM}Read-only repository MCP for web-chat review${RESET}`,
  );
  console.log(`    ${GREEN}$${RESET} taxi                      ${DIM}Show this help${RESET}`);
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}run${RESET}              ${DIM}Start standalone stdio MCP runtime${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}run --http${RESET}       ${DIM}Start standalone Streamable HTTP runtime${RESET}`,
  );
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}run --full${RESET}       ${DIM}Request all bundled modules${RESET}`);
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}--version${RESET}       ${DIM}Print version and exit${RESET}`);
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}run --http --port${RESET} N  ${DIM}Custom port (default: 3848)${RESET}`,
  );
  console.log(
    `    ${GREEN}$${RESET} taxi ${BOLD}run --http --bind-all${RESET}      ${DIM}Bind to 0.0.0.0 (default: 127.0.0.1)${RESET}`,
  );
  console.log("");
  console.log(`  ${BOLD}Commands${RESET}`);
  console.log("");
  console.log(
    `    ${CYAN}setup${RESET}      ${DIM}Choose language and modules; MCP client settings stay unchanged by default${RESET}`,
  );
  console.log(`    ${CYAN}doctor${RESET}     ${DIM}Check Node.js, macOS, permissions, clients, modules${RESET}`);
  console.log(`    ${CYAN}run${RESET}        ${DIM}Start the standalone stdio or HTTP runtime${RESET}`);
  console.log(
    `    ${CYAN}verify${RESET}     ${DIM}Classify audit integrity, assurance, approval, and runtime trust${RESET}`,
  );
  console.log(`    ${CYAN}modules${RESET}    ${DIM}List, enable, disable, or diagnose bundled module packs${RESET}`);
  console.log(`    ${CYAN}connect${RESET}    ${DIM}Bridge stdio clients into the app-owned local runtime${RESET}`);
  console.log(
    `    ${CYAN}clients${RESET} ${DIM}Configure installed clients for app-owned or direct stdio runtime${RESET}`,
  );
  console.log(`    ${CYAN}codex${RESET}      ${DIM}Inspect, enable, or disable the persistent Codex MCP entry${RESET}`);
  console.log(
    `    ${CYAN}workflows${RESET}  ${DIM}Show target workflows, prompts, modules, Siri phrases, safety notes${RESET}`,
  );
  console.log("");
  console.log(`  ${BOLD}Environment Variables${RESET}`);
  console.log("");
  console.log(`    ${WHITE}TAXI_FULL${RESET}=true              ${DIM}Request all installed modules${RESET}`);
  console.log(
    `    ${WHITE}TAXI_PROFILE${RESET}=${DIM}starter|communications-safe|productivity|full|custom${RESET} ${DIM}Choose module profile${RESET}`,
  );
  console.log(
    `    ${WHITE}TAXI_TOOL_EXPOSURE${RESET}=${DIM}progressive|profile|full${RESET} ${DIM}Control tools/list size${RESET}`,
  );
  console.log(
    `    ${WHITE}TAXI_MODULE_PACKS${RESET}=${DIM}core,productivity${RESET} ${DIM}Activate selected bundled module packs${RESET}`,
  );
  console.log(
    `    ${WHITE}TAXI_HARNESS_ADAPTER${RESET}=${DIM}compatible|strict|app-runtime|agent${RESET} ${DIM}Choose task harness policy${RESET}`,
  );
  console.log(`    ${WHITE}TAXI_DISABLE_${RESET}${DIM}<MODULE>${RESET}=true  ${DIM}Disable a specific module${RESET}`);
  console.log(`    ${WHITE}GEMINI_API_KEY${RESET}=${DIM}<key>${RESET}          ${DIM}Enable Gemini embeddings${RESET}`);
  console.log(
    `    ${WHITE}TAXI_EMBEDDING_MODEL${RESET}=${DIM}...${RESET}    ${DIM}Embedding model (default: gemini-embedding-2)${RESET}`,
  );
  console.log(
    `    ${WHITE}TAXI_EMBEDDING_PROVIDER${RESET}=${DIM}...${RESET} ${DIM}auto / gemini / swift / hybrid${RESET}`,
  );
  console.log(
    `    ${WHITE}TAXI_HTTP_TOKEN${RESET}=${DIM}<secret>${RESET}       ${DIM}Bearer token for HTTP mode auth${RESET}`,
  );
  console.log(
    `    ${WHITE}TAXI_NPM_PACKAGE_SPECIFIER${RESET}=${DIM}<specifier>${RESET} ${DIM}Override app-owned proxy package${RESET}`,
  );
  console.log("");
  console.log(`  ${BOLD}Config${RESET}  ${DIM}~/.config/taxi/config.json${RESET}`);
  console.log(`  ${BOLD}Docs${RESET}    ${DIM}https://github.com/heznpc/Taxi${RESET}`);
  console.log(`  ${BOLD}Web${RESET}     ${DIM}https://heznpc.github.io/Taxi/${RESET}`);
  console.log("");
}
