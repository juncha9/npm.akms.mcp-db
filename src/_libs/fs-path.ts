import fs from "node:fs";
import path from "node:path";

/**
 * Absolute path of an executable on `PATH`, or null. On Windows only `PATHEXT` suffixes are
 * tried — npm drops an extensionless POSIX shell script next to every `.cmd` shim, and that
 * file exists but cannot be launched.
 */
export function findExecutable(name: string): string | null {
    const searchPath = process.env.PATH ?? "";
    const directories = searchPath.split(path.delimiter).filter((directory) => directory !== "");

    let suffixes = [""];
    if(process.platform === "win32") {
        const pathExt = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
        suffixes = pathExt.split(";").filter((suffix) => suffix !== "");
    }

    for(const directory of directories) {
        for(const suffix of suffixes) {
            const candidate = path.join(directory, `${name}${suffix}`);
            if(fs.existsSync(candidate) == true && fs.statSync(candidate).isFile() == true) {
                return candidate;
            }
        }
    }

    return null;
}
