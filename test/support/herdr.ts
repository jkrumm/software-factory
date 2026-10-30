import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeHerdr {
  /** value for `HERDR_BIN` */
  bin: string;
  /** exit codes for the next calls, in order; once used up the script behaves like herdr */
  plan(...exitCodes: number[]): Promise<void>;
  /** the `--name` of every call so far */
  calls(): Promise<string[]>;
  /** tab names that exist */
  panes(): Promise<string[]>;
  /** forgets calls, tabs and the plan */
  reset(): Promise<void>;
  cleanup(): Promise<void>;
}

const script = (dir: string) => `#!/bin/sh
dir='${dir}'
[ "$1 $2" = "tab create" ] || exit 64
name=''
while [ $# -gt 0 ]; do
  [ "$1" = "--name" ] && name="$2"
  shift
done
echo "$name" >> "$dir/calls"
code=0
if [ -s "$dir/plan" ]; then
  code=$(head -n 1 "$dir/plan")
  tail -n +2 "$dir/plan" > "$dir/plan.tmp"
  mv "$dir/plan.tmp" "$dir/plan"
fi
[ "$code" = 0 ] || exit "$code"
[ -e "$dir/panes/$name" ] && exit 3
touch "$dir/panes/$name"
printf '{"pane":"pane-%s"}\\n' "$name"
`;

/** A stand-in for the herdr binary: records calls, keeps tab names, and fails on demand. */
export async function createFakeHerdr(): Promise<FakeHerdr> {
  const dir = await mkdtemp("/tmp/factory-herdr-");
  await mkdir(join(dir, "panes"));
  await writeFile(join(dir, "calls"), "");
  await writeFile(join(dir, "plan"), "");
  const bin = join(dir, "herdr");
  await writeFile(bin, script(dir));
  await chmod(bin, 0o755);

  return {
    bin,
    plan: (...codes) => writeFile(join(dir, "plan"), codes.map((c) => `${c}\n`).join("")),
    calls: async () => (await readFile(join(dir, "calls"), "utf8")).split("\n").filter(Boolean),
    panes: () => readdir(join(dir, "panes")),
    reset: async () => {
      await rm(join(dir, "panes"), { recursive: true, force: true });
      await mkdir(join(dir, "panes"));
      await writeFile(join(dir, "calls"), "");
      await writeFile(join(dir, "plan"), "");
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
