import { PageStackError } from "./errors.js";
import type { Intent, Interception } from "./internal.js";
import type { Operation, ResolvedRoute, RouteInput } from "./types.js";

export interface Plan {
  history: ResolvedRoute[];
  popups: ResolvedRoute[];
  from: ResolvedRoute | undefined;
  to: ResolvedRoute | undefined;
  entering: ResolvedRoute[];
  leaving: ResolvedRoute[];
  operation: Operation;
  noop: "root" | "empty" | "same" | "not-intercepted" | undefined;
  interception: Interception | undefined;
  redirected: boolean;
}
/** 纯导航规划只计算历史和覆盖层，不创建组件、调用守卫或修改外部输入。 */
export function createPlanner(
  options: {
    maxHistory: number;
    maxPopups: number;
    closePopupsOnNavigate: boolean;
  },
  normalize: (route: RouteInput, fresh: boolean) => ResolvedRoute,
) {
  function limit(routes: ResolvedRoute[]): ResolvedRoute[] {
    const root = routes[0]?.kind === "tab" ? routes[0] : undefined;
    const normals = root ? routes.slice(1) : routes;
    return [...(root ? [root] : []), ...normals.slice(-options.maxHistory)];
  }
  function validateHistory(
    routes: readonly ResolvedRoute[],
    popupRoutes: readonly ResolvedRoute[],
  ): void {
    const identities = new Set<string>();
    for (const [index, route] of routes.entries()) {
      if (route.kind === "popup" || (route.kind === "tab" && index !== 0))
        throw new PageStackError(
          "INVALID_KIND",
          "History contains pages and at most one Tab root.",
        );
    }
    for (const route of [...routes, ...popupRoutes]) {
      const identity = `${route.name}\0${route.key}`;
      if (identities.has(identity))
        throw new PageStackError(
          "DUPLICATE_KEY",
          `Page "${route.name}" key "${route.key}" already exists in this navigation stack.`,
        );
      identities.add(identity);
    }
  }
  function plan(
    intent: Intent,
    baseHistory: readonly ResolvedRoute[],
    basePopups: readonly ResolvedRoute[],
    fresh: boolean,
  ): Plan {
    const next: Plan = {
      history: [...baseHistory],
      popups: [...basePopups],
      from: basePopups.at(-1) ?? baseHistory.at(-1),
      to: undefined,
      entering: [],
      leaving: [],
      operation: intent.operation,
      noop: undefined,
      interception: undefined,
      redirected: false,
    };
    const operation = intent.operation;
    if (operation === "back" || operation === "closePopup") {
      if (
        operation === "back" &&
        (!Number.isSafeInteger(intent.delta ?? 1) || (intent.delta ?? 1) < 1)
      ) {
        throw new PageStackError("INVALID_ROUTE", "Back delta must be a positive integer.");
      }
      if (next.popups.length) {
        const removed = next.popups.pop()!;
        next.leaving = [removed];
        next.operation = "closePopup";
      } else if (operation === "closePopup") next.noop = "empty";
      else if (next.history.length < 2) next.noop = "root";
      else {
        const delta = intent.delta ?? 1;
        if (!Number.isSafeInteger(delta) || delta < 1)
          throw new PageStackError("INVALID_ROUTE", "Back delta must be a positive integer.");
        next.leaving = [next.history.at(-1)!];
        next.history.splice(Math.max(1, next.history.length - delta));
      }
      next.to = next.popups.at(-1) ?? next.history.at(-1);
      if (!next.noop && next.to) next.entering = [next.to];
      return next;
    }
    if (operation === "reset") {
      if (!Array.isArray(intent.routes) || intent.routes.length < 1)
        throw new PageStackError("INVALID_ROUTE", "Reset requires a non-empty route array.");
      next.history = intent.routes.map((route) => normalize(route, fresh));
      next.entering = [...next.history];
    } else {
      const route = normalize(intent.route!, fresh);
      const expected =
        operation === "switchTab" ? "tab" : operation === "openPopup" ? "popup" : "page";
      if (route.kind !== expected)
        throw new PageStackError(
          "INVALID_KIND",
          `${operation} requires a ${expected} route; "${route.name}" is ${route.kind}.`,
        );
      next.entering = [route];
      if (operation === "openPopup") {
        if (next.popups.length >= options.maxPopups)
          throw new PageStackError(
            "POPUP_LIMIT",
            `Popup depth is limited to ${options.maxPopups}.`,
          );
        next.popups.push(route);
        next.to = route;
        validateHistory(next.history, next.popups);
        return next;
      }
      if (operation === "switchTab") next.history = [route];
      else if (operation === "replace") {
        if (next.history.length) next.history[next.history.length - 1] = route;
        else next.history.push(route);
      } else next.history.push(route);
    }
    validateHistory(next.history, next.popups);
    next.history = limit(next.history);
    if (options.closePopupsOnNavigate) {
      next.leaving.push(...[...next.popups].reverse());
      next.popups = [];
    }
    const fromClassic = baseHistory.at(-1);
    next.to = next.history.at(-1);
    next.from = fromClassic;
    if (fromClassic && fromClassic.id !== next.to?.id) next.leaving.push(fromClassic);
    if (
      !fresh &&
      baseHistory.length === next.history.length &&
      basePopups.length === next.popups.length &&
      baseHistory.every(
        (route, index) =>
          route.id === next.history[index]?.id && route.params === next.history[index]?.params,
      )
    ) {
      next.noop = "same";
    }
    return next;
  }
  return plan;
}
