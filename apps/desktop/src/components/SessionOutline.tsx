/**
 * Session outline rail: lists every user prompt in the current chat.
 * Default = collapsed dots, vertically centered on the chat edge.
 * Hover a dot to preview content; click jumps to that message.
 * Expanded = short text list for browsing.
 */
import { memo, useMemo, useState } from "react";

export type OutlineEntry = {
  id: string;
  text: string;
  /** Optional ISO time for tooltip. */
  at?: string;
};

type Props = {
  entries: OutlineEntry[];
  /** Currently highlighted / sticky user message (if any). */
  activeId?: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onJump: (id: string) => void;
};

function previewText(text: string, max = 72): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return "(empty)";
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function formatTime(iso?: string): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

export const SessionOutline = memo(function SessionOutline({
  entries,
  activeId,
  collapsed,
  onToggleCollapsed,
  onJump,
}: Props) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  const items = useMemo(
    () =>
      entries.map((e, i) => ({
        ...e,
        index: i + 1,
        preview: previewText(e.text, collapsed ? 96 : 42),
        time: formatTime(e.at),
      })),
    [entries, collapsed],
  );

  if (items.length === 0) return null;

  return (
    <aside
      className={`session-outline${collapsed ? " is-collapsed" : ""}`}
      aria-label="Session prompts"
    >
      <div className="session-outline-rail">
        <button
          type="button"
          className="session-outline-toggle"
          title={collapsed ? "Expand prompt list" : "Collapse to dots"}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          <span className="session-outline-toggle-icon" aria-hidden>
            {collapsed ? "›" : "‹"}
          </span>
          {!collapsed && (
            <span className="session-outline-toggle-label">
              Inputs · {items.length}
            </span>
          )}
        </button>

        <div className="session-outline-list" role="list">
          {items.map((item) => {
            const active = activeId === item.id;
            const hovering = hoverId === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="listitem"
                className={`session-outline-item${active ? " is-active" : ""}${
                  hovering ? " is-hover" : ""
                }`}
                aria-label={`Jump to prompt ${item.index}: ${item.preview}`}
                onClick={() => onJump(item.id)}
                onMouseEnter={() => setHoverId(item.id)}
                onMouseLeave={() =>
                  setHoverId((cur) => (cur === item.id ? null : cur))
                }
                onFocus={() => setHoverId(item.id)}
                onBlur={() =>
                  setHoverId((cur) => (cur === item.id ? null : cur))
                }
              >
                <span className="session-outline-dot" aria-hidden />
                {!collapsed && (
                  <span className="session-outline-text">
                    <span className="session-outline-index">{item.index}</span>
                    <span className="session-outline-preview">
                      {item.preview}
                    </span>
                  </span>
                )}
                {/* Collapsed: floating preview to the left of the dot. */}
                {collapsed && hovering && (
                  <span className="session-outline-tip" role="tooltip">
                    <span className="session-outline-tip-meta">
                      #{item.index}
                      {item.time ? ` · ${item.time}` : ""}
                    </span>
                    <span className="session-outline-tip-body">
                      {item.preview}
                    </span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
});
