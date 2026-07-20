/**
 * Unit tests for verbal-only completion detection.
 * Drives the shipped helpers in verbalCompletion.ts (not a reimplementation).
 *
 * Run: npx --yes tsx src/lib/verbalCompletion.test.ts
 */
import {
  detectVerbalOnlyCompletion,
  isVerbalProgressOnly,
  userWantsDeliverable,
  type VerbalChatLine,
} from "./verbalCompletion.ts";

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

// --- isVerbalProgressOnly: previously missed phrases ---
check("正在编写并生成完整的 Word 文档 is verbal", () => {
  assert(
    isVerbalProgressOnly("正在编写并生成完整的 Word 文档。"),
    "should match 编写/并生成",
  );
});

check("正在生成完整 is verbal", () => {
  assert(
    isVerbalProgressOnly("正在生成完整的半年研发总结 Word 文档。"),
    "should match 生成完整",
  );
});

check("继续生成 is verbal", () => {
  assert(
    isVerbalProgressOnly("继续生成半年研发总结 Word 文档。"),
    "should match 继续生成",
  );
});

check("delivery with path is not verbal-only", () => {
  assert(
    !isVerbalProgressOnly(
      "已完成生成，Word 已保存到 project/半年研发总结.docx，确认文件存在。",
    ),
    "completed + path should not be verbal-only",
  );
});

// --- userWantsDeliverable ---
check("继续做吧 is deliverable intent", () => {
  assert(userWantsDeliverable("继续做吧"), "continue work");
});

check("who are you is not deliverable", () => {
  assert(!userWantsDeliverable("who are you"), "pure Q&A");
});

// --- detectVerbalOnlyCompletion fixtures (plan verification) ---
check("(a) tools then 正在编写并生成… → hit shouldNudge", () => {
  const lines: VerbalChatLine[] = [
    { kind: "user", text: "继续做吧" },
    {
      kind: "trace",
      items: [
        { id: "t1", kind: "thought", text: "continue" },
        { id: "t2", kind: "tool", text: "run_terminal_command" },
        { id: "t3", kind: "tool", text: "npm install docx" },
        { id: "t4", kind: "tool", text: "tool → completed" },
        { id: "t5", kind: "tool", text: "list_dir" },
        { id: "t6", kind: "tool", text: "tool → completed" },
      ],
    },
    { kind: "assistant", text: "继续生成半年研发总结 Word 文档。" },
    { kind: "assistant", text: "正在编写并生成完整的 Word 文档。" },
  ];
  const hit = detectVerbalOnlyCompletion(lines);
  assert(hit, "expected hit");
  assert(hit!.shouldNudge === true, "shouldNudge true");
  assert(/正在生成|未见最终交付|未真正执行/.test(hit!.warning), "warning text");
});

check("(b) zero tools + 正在生成完整… → hit", () => {
  const lines: VerbalChatLine[] = [
    { kind: "user", text: "怎么停止了" },
    {
      kind: "trace",
      items: [{ id: "th", kind: "thought", text: "should proceed" }],
    },
    {
      kind: "assistant",
      text: "刚才中断了，现在继续把半年研发总结 Word 文档生成出来。",
    },
  ];
  // thought-only trace = 0 tools
  const hit = detectVerbalOnlyCompletion(lines);
  assert(hit, "expected hit with zero tools");
  assert(hit!.shouldNudge === true, "shouldNudge");
});

check("(b2) zero tools short verbal → hit", () => {
  const lines: VerbalChatLine[] = [
    { kind: "user", text: "生成 word 文档" },
    { kind: "assistant", text: "正在生成完整的半年研发总结 Word 文档。" },
  ];
  const hit = detectVerbalOnlyCompletion(lines);
  assert(hit, "expected hit");
  assert(hit!.shouldNudge === true, "shouldNudge");
});

check("(c) who are you + short answer → no hit", () => {
  const lines: VerbalChatLine[] = [
    { kind: "user", text: "who are you" },
    { kind: "assistant", text: "I am Grokx, a desktop coding assistant." },
  ];
  const hit = detectVerbalOnlyCompletion(lines);
  assert(hit === null, "Q&A must not nudge");
});

check("delivery proof last message → no hit", () => {
  const lines: VerbalChatLine[] = [
    { kind: "user", text: "生成 word" },
    {
      kind: "trace",
      items: [{ id: "t", kind: "tool", text: "run node generate.js" }],
    },
    {
      kind: "assistant",
      text: "已完成生成，文件已保存到 project/半年研发总结.docx，确认文件存在。",
    },
  ];
  const hit = detectVerbalOnlyCompletion(lines);
  assert(hit === null, "real delivery should not nudge");
});

if (process.exitCode && process.exitCode !== 0) {
  console.error(`\n${passed} passed before failure`);
  process.exit(1);
}
console.log(`\nAll ${passed} checks passed (shipped verbalCompletion.ts).`);
