import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./validate-worker.js", import.meta.url));

export function runValidation(workspace, kind, id = "", { timeout = 150_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [worker, kind, id], {
      cwd: workspace,
      encoding: "utf8",
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || (error.killed ? `Validation exceeded its ${timeout}ms deadline.` : error.message)));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Validation worker returned an invalid result."));
      }
    });
  });
}
