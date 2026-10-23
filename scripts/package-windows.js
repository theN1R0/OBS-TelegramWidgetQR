import { parseArgs } from "node:util";
import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: { dll: { type: "string" }, runtime: { type: "string" } },
});
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error(
    "Build this package on Windows x64; sharp binaries must match the target.",
  );
if (!values.dll)
  throw new Error("Pass --dll <path to the compiled telegram-widget.dll>.");
const dll = path.resolve(values.dll),
  runtime = path.resolve(values.runtime || process.execPath);
await access(dll);
await access(runtime);
await access(path.join(root, "dist/index.html"));
const nodeLicense = path.join(path.dirname(runtime), "LICENSE");
await access(nodeLicense);
const runtimeInfo = spawnSync(
  runtime,
  [
    "-p",
    "JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node})",
  ],
  { encoding: "utf8" },
);
if (runtimeInfo.status !== 0)
  throw new Error("Cannot execute the selected Node runtime.");
const info = JSON.parse(runtimeInfo.stdout);
const [major, minor] = info.node.split(".").map(Number);
if (
  info.platform !== "win32" ||
  info.arch !== "x64" ||
  major < 22 ||
  (major === 22 && minor < 15)
)
  throw new Error("Use Node.js >=22.15 Windows x64.");
const out = path.join(
  root,
  "package",
  `telegram-widget-0.1.0-win64-${Date.now()}`,
);
const data = path.join(out, "data/obs-plugins/telegram-widget");
await mkdir(path.join(out, "obs-plugins/64bit"), { recursive: true });
await mkdir(path.join(data, "runtime"), { recursive: true });
await cp(dll, path.join(out, "obs-plugins/64bit/telegram-widget.dll"));
await cp(runtime, path.join(data, "runtime/node.exe"));
for (const folder of ["service", "dist", "data/locale"])
  await cp(
    path.join(root, folder),
    path.join(data, folder === "data/locale" ? "locale" : folder),
    { recursive: true },
  );
const sourcePackage = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const lock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);
// Keep the exact tested runtime dependency versions; exclude development tools.
delete sourcePackage.devDependencies;
sourcePackage.scripts = {};
delete lock.packages[""].devDependencies;
await writeFile(
  path.join(data, "package.json"),
  JSON.stringify(sourcePackage, null, 2),
);
await writeFile(
  path.join(data, "package-lock.json"),
  JSON.stringify(lock, null, 2),
);
const installed = spawnSync(
  "npm.cmd",
  ["ci", "--omit=dev", "--no-audit", "--no-fund", "--workspaces=false"],
  { cwd: data, stdio: "inherit", shell: true },
);
if (installed.status !== 0)
  throw new Error(
    "Runtime dependency installation failed. Incomplete package was not published.",
  );
await cp(
  path.join(root, "scripts/install-windows.ps1"),
  path.join(out, "Install.ps1"),
);
await cp(path.join(root, "README.md"), path.join(out, "README.md"));
for (const preview of ["qrprew.png", "qrpanelprew.png"])
  await cp(path.join(root, preview), path.join(out, preview));
await cp(path.join(root, "docs/assets"), path.join(out, "docs/assets"), {
  recursive: true,
});
await cp(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
await cp(
  path.join(root, "docs/source-manifest.json"),
  path.join(data, "source-manifest.json"),
);
try {
  await cp(nodeLicense, path.join(data, "runtime/LICENSE"));
} catch {
  throw new Error(
    "Node runtime LICENSE is missing. Put the official LICENSE next to node.exe before packaging.",
  );
}
const notices = [];
for (const [name, entry] of Object.entries(lock.packages)) {
  if (name && !entry.dev)
    notices.push(
      `${name}: ${entry.version} — ${entry.license || "see package license files"}`,
    );
}
await writeFile(
  path.join(data, "THIRD-PARTY-NOTICES.txt"),
  "Node.js: runtime/LICENSE\nOBS Studio/browser API: GPL-2.0-or-later\n\n" +
    notices.join("\n"),
);
await access(path.join(data, "node_modules/sharp/package.json"));
const smoke = spawnSync(runtime, ["--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  import {mkdtemp,rm} from 'node:fs/promises';
  import {tmpdir} from 'node:os';
  import path from 'node:path';
  import {startServer} from './service/server.js';
  const dir=await mkdtemp(path.join(tmpdir(),'telegram-widget-package-check-'));
  let app;
  try {
    app=await startServer({dir,port:0});
    const response=await fetch(app.origin+'/dock?key='+app.key);
    assert.equal(response.status,200);
    assert.match(await response.text(),/Telegram Widget/);
    console.log('Packaged runtime and HTTP smoke test passed.');
  } finally { if(app)await app.close(); await rm(dir,{recursive:true,force:true}); }
`], { cwd: data, encoding: "utf8", timeout: 30000 });
if (smoke.status !== 0) throw new Error(`Packaged runtime smoke test failed: ${smoke.error?.message || smoke.stderr}`);
console.log(smoke.stdout.trim());
const receipt = {
  directory: out, version: sourcePackage.version, createdAt: new Date().toISOString(),
  nodeVersion: info.node, dllSha256: createHash('sha256').update(await readFile(dll)).digest('hex'),
  runtimeSmokeTest: 'passed', nativeObsLoadTest: 'not-run',
};
await writeFile(path.join(root, 'package/last-build.json'), JSON.stringify(receipt, null, 2));
console.log(`Package ready: ${out}`);
console.log(
  "Contains the Node runtime. Streamers do not need npm, Node.js, StreamOverlay or a web server.",
);
