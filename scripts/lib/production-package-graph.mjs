import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function packageName(relativePath) {
  return relativePath.slice(relativePath.lastIndexOf("node_modules/") + "node_modules/".length);
}

export function expectedProductionPackageGraph(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  return new Map(
    Object.entries(lock.packages ?? {})
      .filter(([relativePath, metadata]) => relativePath.startsWith("node_modules/") && !metadata.dev)
      .map(([relativePath, metadata]) => [
        relativePath,
        { name: packageName(relativePath), version: metadata.version },
      ]),
  );
}

export function installedProductionPackageGraph(nodeModulesRoot) {
  const graph = new Map();

  function recordPackage(directory, relativePath) {
    const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    graph.set(relativePath, { name: metadata.name, version: metadata.version });
    const nested = join(directory, "node_modules");
    try {
      if (statSync(nested).isDirectory()) visitNodeModules(nested, `${relativePath}/node_modules`);
    } catch {
      // A package without nested dependencies is the common case.
    }
  }

  function visitNodeModules(directory, relativePrefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        const scopeDirectory = join(directory, entry.name);
        for (const scoped of readdirSync(scopeDirectory, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          const relativePath = `${relativePrefix}/${entry.name}/${scoped.name}`;
          recordPackage(join(scopeDirectory, scoped.name), relativePath);
        }
      } else {
        const relativePath = `${relativePrefix}/${entry.name}`;
        recordPackage(join(directory, entry.name), relativePath);
      }
    }
  }

  visitNodeModules(nodeModulesRoot, "node_modules");
  return graph;
}

export function compareProductionPackageGraphs(expected, actual) {
  const mismatches = [];
  for (const [relativePath, identity] of expected) {
    const installed = actual.get(relativePath);
    if (!installed) {
      mismatches.push(`${relativePath}: missing (expected ${identity.name}@${identity.version})`);
    } else if (installed.name !== identity.name || installed.version !== identity.version) {
      mismatches.push(
        `${relativePath}: expected ${identity.name}@${identity.version}, got ${installed.name}@${installed.version}`,
      );
    }
  }
  for (const [relativePath, identity] of actual) {
    if (!expected.has(relativePath)) {
      mismatches.push(`${relativePath}: unexpected ${identity.name}@${identity.version}`);
    }
  }
  return mismatches.sort();
}
