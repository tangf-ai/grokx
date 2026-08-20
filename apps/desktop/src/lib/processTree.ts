export type SessionProcLike = {
  pid: number;
  ppid: number;
  command: string;
  etime: string;
  state: string;
  cpu: string;
  mem: string;
  depth: number;
  cwd?: string | null;
  paused: boolean;
};

export type SessionProcNode = SessionProcLike & { children: SessionProcNode[] };

export function shortProcessLabel(command: string): string {
  const raw = (command || "").trim().replace(/\s+/g, " ");
  if (!raw) return "process";
  const mykg = raw.match(/\bmykg\s+(\w+)/i);
  if (mykg) {
    const port = raw.match(/--port\s+(\d+)/);
    return port ? `mykg ${mykg[1]} :${port[1]}` : `mykg ${mykg[1]}`;
  }
  if (/\b(uvicorn|gunicorn)\b/i.test(raw)) {
    const m = raw.match(/\b(uvicorn|gunicorn)\b/i);
    return m ? m[1].toLowerCase() : "server";
  }
  if (/\b(vite|next|webpack-dev-server)\b/i.test(raw)) {
    const m = raw.match(/\b(vite|next|webpack-dev-server)\b/i);
    return m ? m[1] : "dev-server";
  }
  const parts = raw.split(" ");
  let bin = parts[0] || "process";
  bin = bin.split("/").pop() || bin;
  if (bin === "uv" && parts[1] === "run" && parts[2]) {
    return shortProcessLabel(parts.slice(2).join(" "));
  }
  if (bin === "python" || bin === "python3") {
    const script = parts.find((p) => p.endsWith(".py"));
    if (script) return script.split("/").pop() || script;
  }
  const tail = parts.slice(1, 3).join(" ");
  const label = tail ? `${bin} ${tail}` : bin;
  return label.length > 36 ? `${label.slice(0, 33)}…` : label;
}

/** Parent→child trees so `uv run …` + its python worker show as one root. */
export function buildProcessTree(procs: SessionProcLike[]): SessionProcNode[] {
  if (procs.length === 0) return [];
  const byPid = new Map<number, SessionProcNode>();
  for (const p of procs) {
    byPid.set(p.pid, { ...p, children: [] });
  }
  const roots: SessionProcNode[] = [];
  for (const node of byPid.values()) {
    const parent = byPid.get(node.ppid);
    if (parent && parent.pid !== node.pid) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: SessionProcNode[]) => {
    nodes.sort((a, b) => a.pid - b.pid);
    for (const n of nodes) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}
