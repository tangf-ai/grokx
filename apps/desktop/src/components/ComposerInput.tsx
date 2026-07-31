/**
 * Isolated composer textarea.
 * Draft state lives here so keystrokes do NOT re-render the full App
 * (chat list, sidebar, outputs) — critical for long sessions.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";

export type ComposerInputHandle = {
  getValue: () => string;
  setValue: (v: string) => void;
  clear: () => void;
  focus: () => void;
  /** Current trimmed emptiness (for parent that needs a cheap check). */
  isEmpty: () => boolean;
};

type Props = {
  disabled?: boolean;
  placeholder?: string;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  onSubmit?: () => void;
  /**
   * Fires on every keystroke — keep handlers cheap (e.g. boolean canSend).
   * Must NOT trigger heavy App re-renders of the chat list.
   */
  onDraftChange?: (text: string) => void;
  /** Fires rarely (debounced) so context meter can include draft tokens. */
  onDraftSettled?: (text: string) => void;
  className?: string;
};

const DRAFT_SETTLE_MS = 400;

export const ComposerInput = memo(
  forwardRef<ComposerInputHandle, Props>(function ComposerInput(
    {
      disabled,
      placeholder,
      onPaste,
      onSubmit,
      onDraftChange,
      onDraftSettled,
      className,
    },
    ref,
  ) {
    const [value, setValue] = useState("");
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onDraftChangeRef = useRef(onDraftChange);
    const onDraftSettledRef = useRef(onDraftSettled);
    onDraftChangeRef.current = onDraftChange;
    onDraftSettledRef.current = onDraftSettled;

    const resize = useCallback(() => {
      const el = taRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, []);

    const notify = useCallback((text: string) => {
      onDraftChangeRef.current?.(text);
      if (!onDraftSettledRef.current) return;
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        onDraftSettledRef.current?.(text);
      }, DRAFT_SETTLE_MS);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        getValue: () => taRef.current?.value ?? value,
        setValue: (v: string) => {
          setValue(v);
          requestAnimationFrame(resize);
          notify(v);
        },
        clear: () => {
          setValue("");
          if (taRef.current) {
            taRef.current.value = "";
            taRef.current.style.height = "auto";
          }
          notify("");
        },
        focus: () => taRef.current?.focus(),
        isEmpty: () => !(taRef.current?.value ?? value).trim(),
      }),
      [value, resize, notify],
    );

    return (
      <textarea
        ref={taRef}
        className={className}
        value={value}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          resize();
          notify(v);
        }}
        onPaste={onPaste}
        onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
    );
  }),
);

ComposerInput.displayName = "ComposerInput";
