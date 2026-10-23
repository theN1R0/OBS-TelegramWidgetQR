import { parseArgs } from "node:util";
import { startServer } from "./server.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    port: { type: "string", default: "45871" },
    "parent-pid": { type: "string" },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Некорректный порт.");
const parentPid = values["parent-pid"] === undefined ? null : Number(values["parent-pid"]);
if (parentPid !== null && (!Number.isInteger(parentPid) || parentPid <= 0))
  throw new Error("Некорректный PID OBS.");
try {
  const app = await startServer({ dir: values["data-dir"], port });
  // Machine-readable handshake. The native plugin does not write this key to OBS logs.
  console.log(
    `TW_READY ${JSON.stringify({ origin: app.origin, key: app.key })}`,
  );
  if (!values["parent-pid"]) {
    console.log(`Панель: ${app.origin}/dock?key=${app.key}`);
    console.log(`Источник OBS 1920×1080: ${app.origin}/overlay?key=${app.key}`);
  }
  let closing = false,
    parentTimer;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(parentTimer);
    await app.close();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  if (values["parent-pid"]) {
    parentTimer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        void close();
      }
    }, 2000);
    parentTimer.unref();
  }
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? "Порт 45871 занят. Закройте второй экземпляр виджета или OBS."
      : error.message,
  );
  process.exitCode = 1;
}
