/**
 * The summary of a CPU profile of the inspector of Node (AL-114, AL-150). The measure scripts of the testkit read their
 * profiles with this module, thus each script gives its records in one form.
 */

/** One node of a CPU profile of the inspector. */
export interface ProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
  readonly children?: readonly number[];
}

/** A CPU profile of the inspector: the call tree, the node of each sample and the time before each sample. */
export interface Profile {
  readonly nodes: readonly ProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

/** The options of a summary. */
export interface SummaryOptions {
  /**
   * The name of the root function. Only the time under a node of that name counts in `totalMs` and in `top`. With no root,
   * each node apart from the idle node, the program node and the garbage collector counts.
   */
  readonly root?: string;
  /** The functions of the step. The summary gives the inclusive time of each one. */
  readonly steps?: readonly string[];
  /** The count of functions in `top`. The default is 25. */
  readonly top?: number;
}

/** One function of the list of the most self time. */
export interface TopFunction {
  /** The name of the function and its place, with no path of the computer. */
  readonly fn: string;
  readonly selfMs: number;
  /** The share of the self time in `totalMs`. */
  readonly share: number;
  /** The callers with the most of this self time, at most 3: the function and its place, and the self time under it. */
  readonly callers: readonly { readonly fn: string; readonly selfMs: number }[];
}

/** The summary of a CPU profile, in milliseconds. */
export interface ProfileSummary {
  /** The time under the root. */
  readonly totalMs: number;
  /** The time of the garbage collector in the whole profile. */
  readonly gcMs: number;
  readonly top: readonly TopFunction[];
  /** The inclusive time of each function of the step. A function counts one time on each path. */
  readonly step: Readonly<Record<string, number>>;
}

// The nodes that are not the work of the program.
const OUTSIDE = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

/** This function gives the place of a frame with no path of the computer. The place starts at the folder `packages` or at a package. */
export function placeOf(frame: ProfileNode["callFrame"]): string {
  if (frame.url === "") return "(native)";
  const at = frame.url.indexOf("/packages/");
  const file = at === -1 ? frame.url.replace(/^file:\/\/.*\/node_modules\//u, "node_modules/") : frame.url.slice(at + 1);
  return `${file}:${frame.lineNumber + 1}`;
}

/** This function gives the self time and the inclusive time of the functions of a profile. */
export function profileSummary(profile: Profile, options: SummaryOptions = {}): ProfileSummary {
  const selfUs = new Map<number, number>();
  profile.samples.forEach((id, index) => selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0)));
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  // The inclusive time of each node: its self time and the time of its children.
  const inclusive = new Map<number, number>();
  const inclusiveOf = (id: number): number => {
    const held = inclusive.get(id);
    if (held !== undefined) return held;
    let total = selfUs.get(id) ?? 0;
    for (const child of byId.get(id)?.children ?? []) total += inclusiveOf(child);
    inclusive.set(id, total);
    return total;
  };
  for (const node of profile.nodes) inclusiveOf(node.id);
  // The nodes that count. With a root, the nodes under each node of the root.
  let counts: (id: number) => boolean = (id) => !OUTSIDE.has(byId.get(id)?.callFrame.functionName ?? "");
  if (options.root !== undefined) {
    const under = new Set<number>();
    const addTree = (id: number): void => {
      under.add(id);
      for (const child of byId.get(id)?.children ?? []) addTree(child);
    };
    for (const node of profile.nodes) if (node.callFrame.functionName === options.root && !under.has(node.id)) addTree(node.id);
    counts = (id) => under.has(id);
  }
  let totalUs = 0;
  let gcUs = 0;
  const self = new Map<string, number>();
  // The self time of each function under each caller.
  const callers = new Map<string, Map<string, number>>();
  const keyOf = (node: ProfileNode): string => `${node.callFrame.functionName || "(anonymous)"} ${placeOf(node.callFrame)}`;
  for (const node of profile.nodes) {
    const us = selfUs.get(node.id) ?? 0;
    if (node.callFrame.functionName === "(garbage collector)") gcUs += us;
    if (!counts(node.id)) continue;
    totalUs += us;
    const key = keyOf(node);
    self.set(key, (self.get(key) ?? 0) + us);
    const up = byId.get(parent.get(node.id) ?? -1);
    if (up !== undefined && us > 0) {
      const held = callers.get(key) ?? new Map<string, number>();
      held.set(keyOf(up), (held.get(keyOf(up)) ?? 0) + us);
      callers.set(key, held);
    }
  }
  const ms = (us: number): number => Number((us / 1000).toFixed(1));
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.top ?? 25)
    .map(([fn, us]) => ({
      fn,
      selfMs: ms(us),
      share: Number((us / Math.max(1, totalUs)).toFixed(3)),
      callers: [...(callers.get(fn) ?? new Map<string, number>()).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([caller, held]) => ({ fn: caller, selfMs: ms(held) })),
    }));
  // A function counts one time on each path: a node with an ancestor of the same name adds nothing.
  const step: Record<string, number> = {};
  for (const name of options.steps ?? []) {
    let us = 0;
    for (const node of profile.nodes) {
      if (node.callFrame.functionName !== name) continue;
      let up = parent.get(node.id);
      let nested = false;
      while (up !== undefined && !nested) {
        nested = byId.get(up)?.callFrame.functionName === name;
        up = parent.get(up);
      }
      if (!nested) us += inclusive.get(node.id) ?? 0;
    }
    step[name] = ms(us);
  }
  return { totalMs: ms(totalUs), gcMs: ms(gcUs), top, step };
}
