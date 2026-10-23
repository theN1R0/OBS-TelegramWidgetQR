// Read-only developer check using preinstalled dependencies from another project.
// Node >=22.15: node scripts/check-local-dependencies.js <directory-containing-node_modules>
import { registerHooks } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import path from "node:path";

const main =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const dependencyRoot = main
  ? path.resolve(process.argv[2] || ".")
  : process.env.TW_CHECK_DEPENDENCIES;
if (!dependencyRoot || !existsSync(path.join(dependencyRoot, "node_modules")))
  throw new Error("Pass a directory containing preinstalled node_modules.");
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error.code !== "ERR_MODULE_NOT_FOUND" ||
        /^[./]|^[a-z]+:/i.test(specifier)
      )
        throw error;
      return nextResolve(specifier, {
        ...context,
        parentURL: pathToFileURL(
          path.join(dependencyRoot, "__local_check__.mjs"),
        ).href,
      });
    }
  },
});
if (main) {
  const tests = spawnSync(
    process.execPath,
    ["--import", import.meta.url, "--test", "test/*.test.js"],
    {
      stdio: "inherit",
      env: { ...process.env, TW_CHECK_DEPENDENCIES: dependencyRoot },
    },
  );
  if (tests.status !== 0) process.exit(tests.status || 1);
  const { build } = await import("vite");
  const { default: config } = await import("../vite.config.js");
  const modules = path.join(dependencyRoot, "node_modules");
  const lucide = JSON.parse(
    readFileSync(path.join(modules, "@lucide/vue/package.json"), "utf8"),
  );
  await build({
    ...config,
    configFile: false,
    logLevel: "warn",
    resolve: {
      alias: {
        vue: path.join(modules, "vue/dist/vue.runtime.esm-bundler.js"),
        qrcode: path.join(modules, "qrcode/lib/browser.js"),
        "@lucide/vue": path.join(modules, "@lucide/vue", lucide.module),
        "@fontsource": path.join(modules, "@fontsource"),
      },
    },
  });
  console.log("Local dependency check and production build completed.");
}
