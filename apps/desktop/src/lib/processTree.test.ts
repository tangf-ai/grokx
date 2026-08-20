/**
 * Run: npx --yes tsx src/lib/processTree.test.ts
 */
import { buildProcessTree, shortProcessLabel } from "./processTree.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

check("nests child under parent", () => {
  const tree = buildProcessTree([
    {
      pid: 2,
      ppid: 1,
      command: "python server.py",
      etime: "00:01",
      state: "S",
      cpu: "0",
      mem: "0",
      depth: 2,
      paused: false,
    },
    {
      pid: 1,
      ppid: 0,
      command: "uv run python server.py",
      etime: "00:01",
      state: "S",
      cpu: "0",
      mem: "0",
      depth: 1,
      paused: false,
    },
  ]);
  assert(tree.length === 1, "one root");
  assert(tree[0].pid === 1, "uv is root");
  assert(tree[0].children.length === 1, "one child");
  assert(tree[0].children[0].pid === 2, "python nested");
});

check("shortProcessLabel uv run", () => {
  assert(
    shortProcessLabel("uv run python server.py") === "server.py",
    shortProcessLabel("uv run python server.py"),
  );
});

if (!process.exitCode) console.log(`${passed} passed`);
