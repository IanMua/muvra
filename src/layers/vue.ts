import {
  defineComponent,
  h,
  mergeProps,
  onErrorCaptured,
  onScopeDispose,
  shallowRef,
  watch,
} from "vue";
import type { PropType } from "vue";
import type { LayerEntry, LayerStack } from "./types.js";

const LayerContent = defineComponent({
  name: "LayerContent",
  props: { entry: { type: Object as PropType<LayerEntry>, required: true } },
  setup(props) {
    onErrorCaptured((error) => {
      if (!props.entry.onError) return;
      props.entry.onError(error);
      return false;
    });
    return () => props.entry.content?.();
  },
});

const layerViewProps = {
  stack: { type: Object as PropType<LayerStack>, required: true },
  onRoot: { type: Function as PropType<(element: HTMLElement | undefined) => void> },
} as const;

/** 普通 Vue 子树保留注入、错误边界和卸载语义；页面和装饰层都经过同一个渲染器。 */
const BoundLayerStackView = defineComponent({
  name: "LayerStackView",
  inheritAttrs: false,
  props: layerViewProps,
  setup(props, { attrs }) {
    const state = shallowRef(props.stack.getSnapshot());
    const lease = props.stack.attachRenderer();
    const unsubscribe = props.stack.subscribe((value) => {
      state.value = value;
    });
    onScopeDispose(() => {
      unsubscribe();
      lease.dispose();
      props.onRoot?.(undefined);
    });
    return () =>
      h(
        "div",
        mergeProps(attrs, {
          "data-layer-stack": "",
          ref: (element: unknown) =>
            props.onRoot?.((element ?? undefined) as HTMLElement | undefined),
          style: {
            position: "relative",
            overflow: "hidden",
            width: "100%",
            height: "100%",
            isolation: "isolate",
          },
        }),
        state.value.layers.map((entry) =>
          h(
            "div",
            {
              ...entry.attrs,
              key: entry.anchor.id,
              "data-layer-id": entry.anchor.id,
              ref: (element: unknown) =>
                lease.bind(entry.anchor, (element ?? undefined) as HTMLElement | undefined),
              style: {
                ...entry.style,
                position: "absolute",
                inset: "0",
                display: entry.visible ? "block" : "none",
                zIndex: entry.zIndex,
                pointerEvents: entry.interactive && entry.visible ? "auto" : "none",
              },
            },
            [h(LayerContent, { entry })],
          ),
        ),
      );
  },
});

// 更换独立图层栈时重建租约，避免把新实例的锚点写入旧实例渲染器。
export const LayerStackView = defineComponent({
  name: "LayerStackView",
  inheritAttrs: false,
  props: layerViewProps,
  setup(props, { attrs }) {
    const binding = shallowRef(Symbol("layer-view"));
    watch(
      () => props.stack,
      () => {
        binding.value = Symbol("layer-view");
      },
      { flush: "sync" },
    );
    return () =>
      h(BoundLayerStackView, {
        ...attrs,
        stack: props.stack,
        ...(props.onRoot ? { onRoot: props.onRoot } : {}),
        key: binding.value,
      });
  },
});
