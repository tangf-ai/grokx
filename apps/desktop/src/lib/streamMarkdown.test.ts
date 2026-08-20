/**
 * Run: npx --yes tsx src/lib/streamMarkdown.test.ts
 */
import { splitStreamingMarkdown } from "./streamMarkdown.ts";

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

check("closed fences stay in closed", () => {
  const src = "hello\n```js\nconst x = 1;\n```\nbye";
  const p = splitStreamingMarkdown(src);
  assert(p.openFence === null, "no open fence");
  assert(p.closed === src, "all closed");
});

check("open fence is split off", () => {
  const src = "intro\n```rust\nfn main() {\n";
  const p = splitStreamingMarkdown(src);
  assert(p.closed === "intro\n", `closed was ${JSON.stringify(p.closed)}`);
  assert(
    p.openFence === "```rust\nfn main() {\n",
    `open was ${JSON.stringify(p.openFence)}`,
  );
});

check("empty is closed", () => {
  const p = splitStreamingMarkdown("");
  assert(p.closed === "" && p.openFence === null, "empty");
});

check("tilde fences", () => {
  const p = splitStreamingMarkdown("a\n~~~~\ncode");
  assert(p.closed === "a\n", "closed prefix");
  assert(p.openFence?.startsWith("~~~~") === true, "open tilde fence");
});

if (!process.exitCode) {
  console.log(`${passed} passed`);
}
