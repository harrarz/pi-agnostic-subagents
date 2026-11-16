// CI diagnostics only: never print process arguments, environments, or tokens.
import { readFile, readdir, stat } from "node:fs/promises";

if (process.platform === "linux" && process.getuid) {
  const report = { sameUser: 0, readable: 0, disappeared: 0, unavailable: {} };
  for (const name of (await readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    try {
      if ((await stat(`/proc/${name}`)).uid !== process.getuid()) continue;
      report.sameUser++;
      await readFile(`/proc/${name}/environ`);
      report.readable++;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "unknown";
      if (["ENOENT", "ESRCH"].includes(code)) report.disappeared++;
      else report.unavailable[code] = (report.unavailable[code] ?? 0) + 1;
    }
  }
  console.log("Redacted Linux process inspection:", JSON.stringify(report));
}
