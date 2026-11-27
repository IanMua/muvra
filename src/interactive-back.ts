import type { BackPreview, BackRenderer, BackTarget } from "./internal.js";
import type { BackSession, BackState, NavigationOptions, NavigationResult } from "./types.js";

const delegate = Object.freeze({ mode: "delegate" } as const);
const busy = Object.freeze({ mode: "busy" } as const);

interface Offer {
  target: BackTarget;
  state: Extract<BackState, { token: string }>;
}
interface Interaction {
  preview?: BackPreview;
  removeSignal(): void;
}

/** 候选和手势各有独立寿命。旧会话失效以后，确认也不会针对新的栈重新规划。 */
export function createBackInteraction(
  commit: (options: NavigationOptions, preview?: BackPreview) => Promise<NavigationResult>,
) {
  const instance = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  let generation = 0;
  let offer: Offer | undefined;
  let active: Interaction | undefined;
  let rewinding: BackPreview | undefined;

  function stopRewind(): void {
    const previous = rewinding;
    rewinding = undefined;
    previous?.dispose();
  }
  function release(interaction: Interaction): void {
    active = undefined;
    interaction.removeSignal();
  }
  function invalidate(): void {
    const previous = active;
    offer = undefined;
    if (previous) release(previous);
    stopRewind();
    previous?.preview?.dispose();
  }

  function state(
    target: BackTarget | undefined,
    isBusy: boolean,
    renderer?: BackRenderer,
  ): BackState {
    if (isBusy || !target) {
      offer = undefined;
      return isBusy ? busy : delegate;
    }
    if (
      offer &&
      (offer.target.from !== target.from ||
        offer.target.to !== target.to ||
        offer.target.operation !== target.operation)
    )
      offer = undefined;
    const mode = renderer?.available(target) ? "interactive" : "commit-only";
    if (offer?.state.mode !== mode) {
      const token = offer?.state.token ?? `${instance}:${++generation}`;
      offer = { target, state: Object.freeze({ mode, token }) };
    }
    return offer.state;
  }
  function withdrawPreview(): void {
    if (offer?.state.mode !== "commit-only") return;
    // 能力先发布再清理，避免效果的清理回调同步发起导航时干扰快照构造。
    const previous = active?.preview;
    if (active) delete active.preview;
    previous?.dispose();
    stopRewind();
  }

  function begin(
    token: string,
    options: NavigationOptions,
    renderer?: BackRenderer,
  ): BackSession | undefined {
    const candidate = offer;
    if (
      !candidate ||
      candidate.state.token !== token ||
      active ||
      !options ||
      typeof options !== "object"
    )
      return;
    const captured = { ...options };
    const signal = captured.signal;
    if (
      signal !== undefined &&
      (!signal ||
        signal.aborted ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    )
      return;
    const abortPreview = () => {
      if (active !== interaction) return;
      release(interaction);
      interaction.preview?.dispose();
    };
    const interaction: Interaction = {
      removeSignal: () => signal?.removeEventListener("abort", abortPreview),
    };
    active = interaction;
    try {
      signal?.addEventListener("abort", abortPreview, { once: true });
    } catch {
      active = undefined;
      return;
    }
    stopRewind();
    if (active !== interaction) return;
    if (candidate.state.mode === "interactive") {
      const preview = renderer?.start(candidate.target);
      if (active !== interaction) {
        preview?.dispose();
        return;
      }
      if (preview) interaction.preview = preview;
    }
    let result: Promise<NavigationResult | undefined> | undefined;
    return Object.freeze<BackSession>({
      update(progress) {
        if (
          active === interaction &&
          offer?.state.mode === "interactive" &&
          Number.isFinite(progress)
        )
          interaction.preview?.update(Math.min(1, Math.max(0, progress)));
      },
      cancel() {
        if (active !== interaction) return;
        release(interaction);
        const preview = interaction.preview;
        if (preview) {
          rewinding = preview;
          const clear = () => {
            if (rewinding === preview) rewinding = undefined;
          };
          void preview.rewind().then(clear, clear);
        }
      },
      commit() {
        if (result) return result;
        if (active !== interaction || offer?.state.token !== token)
          return Promise.resolve(undefined);
        // 先保存结果句柄，requested 观察者同步重入时也只能拿到这一次提交。
        let resolve!: (value: Promise<NavigationResult>) => void;
        result = new Promise((done) => {
          resolve = done;
        });
        release(interaction);
        const preview = offer.state.mode === "interactive" ? interaction.preview : undefined;
        preview?.waitForCommit();
        resolve(commit(captured, preview));
        if (!preview) interaction.preview?.dispose();
        return result;
      },
    });
  }

  return { state, begin, invalidate, withdrawPreview };
}
