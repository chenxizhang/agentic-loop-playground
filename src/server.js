import { execFile } from "node:child_process";
import { createWorkshopServer } from "./server-app.js";

const configuredPort = Number(process.env.PORT ?? 4173);
if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

const app = createWorkshopServer();
let url;
try {
  url = await app.listen({ port: configuredPort });
} catch (error) {
  if (error.code !== "EADDRINUSE" || configuredPort === 0) throw error;
  console.warn(`Port ${configuredPort} is already in use; selecting an available port.`);
  url = await app.listen({ port: 0 });
}

console.log(`Agentic Loop Playground is running at ${url}`);
console.log("Press Ctrl+C to stop.");
if (process.argv.includes("--open")) {
  if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url]);
  } else if (process.platform === "darwin") {
    execFile("open", [url]);
  } else {
    execFile("xdg-open", [url]);
  }
}
