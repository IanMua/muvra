import { build } from "esbuild";
import { sfcPlugin } from "./sfc-plugin.mjs";

// 各实验宿主共享真实 SFC 编译流程，动画宿主额外验证临时组件图层的生命周期。
await build({
  entryPoints: {
    app: "demo/main.ts",
    props: "demo/props.ts",
    effects: "demo/effects.ts",
    layers: "demo/layers.ts",
  },
  outdir: "demo",
  bundle: true,
  format: "esm",
  target: "es2022",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: true,
  plugins: [sfcPlugin()],
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
  },
});
