/**
 * Detect premature end_turn: model claims progress ("正在生成…") without
 * real delivery. Pure helpers so they can be unit-tested without React.
 */

export type VerbalTraceItem = {
  id?: string;
  kind: string;
  text: string;
};

/**
 * Minimal line shape needed by the detector.
 * Compatible with App.tsx ChatLine (extra fields ignored).
 */
export type VerbalChatLine =
  | { kind: "user"; text: string; attachments?: unknown[]; [k: string]: unknown }
  | { kind: "assistant"; text: string; [k: string]: unknown }
  | { kind: "thought"; text: string; [k: string]: unknown }
  | { kind: "tool"; text: string; [k: string]: unknown }
  | { kind: "system"; text: string; [k: string]: unknown }
  | { kind: "error"; text: string; [k: string]: unknown }
  | { kind: "waiting"; text: string; [k: string]: unknown }
  | {
      kind: "trace";
      items: VerbalTraceItem[];
      durationMs?: number;
      expanded?: boolean;
      [k: string]: unknown;
    };

export type VerbalCompletionHit = {
  warning: string;
  shouldNudge: boolean;
};

/** User asked for a concrete deliverable (file / generate / implement), not pure Q&A. */
export function userWantsDeliverable(userText: string): boolean {
  const t = userText.trim();
  if (!t) return false;
  return (
    /生成|创建|输出|导出|写(一|个|份|完)?|完成|继续|开始|实现|修复|修改|改成|做成|保存|落盘|文档|报告|总结|word|docx|pdf|xlsx|pptx|脚本|代码|文件|页面|功能|bug|错误|停止了|中断|卡住|做吧|继续做/i.test(
      t,
    ) ||
    /\b(create|generate|write|implement|fix|build|save|export|docx|word|continue|resume)\b/i.test(
      t,
    )
  );
}

/**
 * Assistant text that claims progress without proving completion.
 * Includes phrases that previously slipped: 正在编写…并生成 / 生成完整.
 */
export function isVerbalProgressOnly(assistantText: string): boolean {
  const t = assistantText.trim();
  if (!t) return true;
  // Allow slightly longer "I'm still generating" status lines.
  if (t.length > 480) return false;

  // Strong Chinese progress / promise patterns (incl. 编写, 并生成, 生成完整).
  if (
    /正在(编写|撰写|生成|创建|写|处理|准备|继续|完成)|编写并|并生成|生成完整|现在(开始|继续|生成|创建|编写)|继续(生成|完成|写|做|编写)|先(生成|创建|写|编写)|我会(先|马上|立即)|马上(生成|创建|写|继续)|接着(做|生成|写)|可以[，,]?\s*现在|刚才中断|不要只|准备生成|正在把|马上把|继续把/i.test(
      t,
    )
  ) {
    return true;
  }

  if (
    /\b(i('ll| will)|let me|now (i'll|i will)|continuing to|about to|generating|working on|proceed(ing)? with)\b/i.test(
      t,
    )
  ) {
    return true;
  }

  // Very short status without paths / confirmation of done work.
  if (
    t.length <= 80 &&
    /(生成|编写|创建|继续|处理中|进行中)/.test(t) &&
    !/(已(经)?(完成|生成|保存|写入)|文件路径|保存到|\.docx|\.pdf|路径[：:]|确认存在)/i.test(
      t,
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Detect premature end_turn for a transcript.
 * Returns a short system warning + whether to auto-nudge, or null if fine.
 */
export function detectVerbalOnlyCompletion(
  lines: VerbalChatLine[],
): VerbalCompletionHit | null {
  let lastUser = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return null;
  const userLine = lines[lastUser];
  if (userLine.kind !== "user") return null;
  if (!userWantsDeliverable(userLine.text) && !(userLine.attachments?.length)) {
    return null;
  }

  const turn = lines.slice(lastUser + 1);
  let toolCount = 0;
  let lastAssistant = "";
  for (const line of turn) {
    if (line.kind === "tool") toolCount += 1;
    if (line.kind === "trace") {
      toolCount += line.items.filter((it) => it.kind === "tool").length;
    }
    if (line.kind === "assistant" && line.text.trim()) {
      lastAssistant = line.text;
    }
    if (
      line.kind === "system" &&
      /未真正执行工具|口头完成|auto-continue|自动续跑|未见最终交付/i.test(
        line.text,
      )
    ) {
      return null;
    }
  }

  // Clear delivery proof in the last assistant message → do not nudge.
  if (
    lastAssistant &&
    /(已(经)?(完成|生成|保存|写入|创建)|保存到|输出路径|文件路径|\.docx|\.pdf|确认(文件)?存在)/i.test(
      lastAssistant,
    ) &&
    !isVerbalProgressOnly(lastAssistant)
  ) {
    return null;
  }

  const verbal = isVerbalProgressOnly(lastAssistant);

  // No tools at all + short / progress claim → premature stop.
  if (toolCount === 0 && (verbal || lastAssistant.length < 280)) {
    return {
      warning:
        "本轮已结束，但未真正执行工具（可能只是口头说「正在生成/继续」）。若任务未完成，将自动续跑一次并强制落盘。",
      shouldNudge: true,
    };
  }

  // Tools then verbal promise (screenshot failure mode): short last assistant
  // claims progress without delivery proof — nudge even with tools earlier.
  if (toolCount > 0 && verbal && lastAssistant.length < 360) {
    return {
      warning:
        "本轮在说「正在生成…」后就结束了，未见最终交付（例如 .docx 落盘）。将自动续跑一次：必须执行工具并确认文件存在。",
      shouldNudge: true,
    };
  }

  return null;
}

/** Follow-up prompt injected when the model ends a turn without real delivery. */
export const VERBAL_COMPLETION_NUDGE = `上轮你只回复了文字就结束了，没有完成交付。请立刻用工具继续，遵守：

1. 不要只说「正在生成/继续」——必须实际执行工具（写文件、运行命令等）
2. 若任务是 Word/docx：用 docx 技能写脚本并 node 运行，把 .docx 写到 project 目录
3. 生成后用 ls/读文件确认产物存在，把完整路径回复我
4. 在确认交付物存在之前，不要结束本轮`;
