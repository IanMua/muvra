import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";

/** Node 集成和浏览器使用同一编译插件，真实 SFC 的脚本及模板都经过 Vue 编译器。 */
export function sfcPlugin() {
  return {
    name: "page-stack-real-sfc",
    setup(build) {
      build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const source = await readFile(path, "utf8");
        const { descriptor, errors } = parse(source, { filename: path });
        if (errors.length) throw errors[0];
        // 实验页面的样式在宿主 HTML 中；未处理的 style 不能被静默丢弃。
        if (descriptor.styles.length)
          throw new Error(`Fixture styles must live in the host: ${path}`);
        const id = createHash("sha256").update(path).digest("hex").slice(0, 12);
        if (!descriptor.script && !descriptor.scriptSetup) {
          // 纯模板也是合法 Vue 页面，直接编译模板，避免为实验夹具强加无意义脚本。
          const template = compileTemplate({
            source: descriptor.template?.content ?? "",
            filename: path,
            id,
          });
          if (template.errors.length) throw template.errors[0];
          return { contents: `${template.code}\nexport default { render };`, loader: "ts" };
        }
        const script = compileScript(descriptor, { id, inlineTemplate: true });
        return { contents: script.content, loader: "ts" };
      });
    },
  };
}
