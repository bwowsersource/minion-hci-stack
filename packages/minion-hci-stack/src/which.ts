// `Bun.which` without Bun: first executable match on PATH. Node has no
// built-in, and pulling in a dependency for one lookup isn't worth it.

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function whichSync(command: string): string | null {
  const path = process.env.PATH;
  if (!path) return null;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}
