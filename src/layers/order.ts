import { LayerError } from "./errors.js";
import type { LayerAnchor, LayerPlacement } from "./types.js";

/** 先验证所有相对约束，再返回稳定的绘制顺序；冲突不会部分写入显示状态。 */
export function resolveLayerOrder<
  T extends { readonly anchor: LayerAnchor; readonly placement: LayerPlacement },
>(records: ReadonlyMap<LayerAnchor, T>, order: readonly LayerAnchor[]): T[] {
  const all = [...records.values()];
  const edges = new Map(all.map((record) => [record.anchor, new Set<LayerAnchor>()]));
  const degrees = new Map(all.map((record) => [record.anchor, 0]));
  const edge = (from: LayerAnchor | undefined, to: LayerAnchor | undefined) => {
    if (!from || !to || !edges.has(from) || !edges.has(to) || edges.get(from)!.has(to)) return;
    edges.get(from)!.add(to);
    degrees.set(to, degrees.get(to)! + 1);
  };
  const base = order.filter((anchor) => records.has(anchor));
  for (let index = 1; index < base.length; index++) edge(base[index - 1], base[index]);
  for (const record of all) {
    edge(record.placement.above, record.anchor);
    edge(record.anchor, record.placement.below);
  }
  const result: T[] = [];
  const available = all.filter((record) => !degrees.get(record.anchor));
  while (available.length) {
    // 创建次序作为稳定次序，约束变化时没有随机的同层闪动。
    available.sort((a, b) => a.anchor.id - b.anchor.id);
    const record = available.shift()!;
    result.push(record);
    for (const next of edges.get(record.anchor)!) {
      degrees.set(next, degrees.get(next)! - 1);
      if (!degrees.get(next)) available.push(records.get(next)!);
    }
  }
  if (result.length !== all.length) throw new LayerError("Layer placement creates a cycle.");
  return result;
}
