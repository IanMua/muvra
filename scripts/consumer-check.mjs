import { mkdtemp, readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
await mkdir(resolve(root, "reports/packages"), { recursive: true });
const run = (command, args, cwd) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolveRun({ stdout, stderr })
        : reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${stdout}\n${stderr}`)),
    );
  });

// 在 /tmp 全新消费者中安装本地产物，避免父目录 node_modules 掩盖漏声明的运行时依赖。
const packed = JSON.parse(
  (
    await run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", "reports/packages"],
      root,
    )
  ).stdout,
);
const archive = resolve(root, "reports/packages", packed[0].filename);
const report = {
  package: archive,
  sha256: createHash("sha256")
    .update(await readFile(archive))
    .digest("hex"),
  consumers: [],
};
const smoke = `import assert from 'node:assert/strict';
import * as api from 'muvra';
const expected=['PageStackError','PageStackView','createPageStack','definePages','handleNativeBack','isPage','lazy','page','popup','tab','usePage','useStackState','compose','defineTransition','sequence','createLayerStack','LayerError','LayerStackView','createResourceScope','defineExtension','createExtensionHost'];
assert.deepEqual(Object.keys(api).sort(),expected.sort());
const {backdrop}=await import('muvra/extensions/backdrop');
assert.equal(typeof backdrop().setup,'function');
const component={render:()=>null};
const stack=api.createPageStack({pages:{home:api.tab(component),order:api.page(component),dialog:api.popup(component)},initial:[{name:'home'}],onError:()=>{}});
await stack.ready;await stack.push({name:'order',params:{id:'42'}});assert.equal(stack.getSnapshot().current.params.id,'42');
await stack.openPopup({name:'dialog'});assert.equal(api.handleNativeBack(stack),'handled');
await new Promise(r=>setTimeout(r,0));assert.equal(stack.getSnapshot().popups.length,0);
const back=stack.getSnapshot().back;assert.equal(back.mode,'commit-only');
const gesture=stack.beginBack(back.token,{reason:'native'});assert.ok(gesture);
gesture.cancel();assert.equal(await gesture.commit(),undefined);
assert.equal((await stack.beginBack(back.token).commit()).state.top.name,'home');
await assert.rejects(import('muvra/dist/internal.js'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
const events=[];
const stop=stack.onNavigation(event=>events.push(event));
const info={custom:'consumer'};
const remove=stack.beforeNavigate(({info:input})=>({info:input ?? info}));
const custom=await stack.push({name:'order',params:{id:'info'}},{info});
assert.equal(custom.info,info);assert.equal(events.length,2);assert.equal(events[1].result,custom);
remove();stop();
stack.dispose();console.log(JSON.stringify({node:process.version,status:'consumer-smoke-passed'}));
`;
const declarations = `import {h} from 'vue';
import {createPageStack,definePages,page,tab,popup,PageStackView,usePage,isPage,handleNativeBack} from 'muvra';
import type {BackState,ProgressTransition} from 'muvra';
const component={render:()=>null};
const pages=definePages({home:tab(component),order:page.withParams<{id:string}>()(component),dialog:popup.withParams<{message:string}>()(component)});
const stack=createPageStack({pages,initial:[{name:'home'}]});
h(PageStackView,{stack,transition:false,pageProps:{tenant:'example'}});
const slide:ProgressTransition={kind:'progress',duration:160,prepare:scope=>progress=>scope.style(scope.from,{opacity:String(1-progress)})};
h(PageStackView,{stack,transition:slide,backPreview:()=>'mounted' as const});
const back:BackState=stack.getSnapshot().back;
if('token' in back) stack.beginBack(back.token)?.update(0.5);
stack.push({name:'order',params:{id:'1'}});
const context=()=>usePage(stack,'order').params.value.id;
const route=stack.getSnapshot().current;if(isPage(stack,route,'order')){const id:string=route.params.id;void id;}
for(const item of stack.catalog){if(item.kind==='tab')stack.switchTab({name:item.name});}
handleNativeBack(stack);
stack.beforeNavigate(({info,signal})=>{const custom:unknown=info;void signal;return {info:custom};});
stack.onNavigation(event=>{if(event.type==='settled'){const info:unknown=event.result.info;void info;}});
stack.push({name:'order',params:{id:'typed'}},{info:{business:true}});
stack.resume({info:undefined});
// @ts-expect-error 发布声明保留必填参数约束。
stack.push({name:'order'});
// @ts-expect-error 发布声明保留页面种类约束。
stack.switchTab({name:'order',params:{id:'1'}});
// @ts-expect-error 守卫重定向名称保持类型约束。
stack.beforeEach(()=>({name:'typo'}));
void context;
`;
const node22Lookup = await run(
  "pnpm",
  ["dlx", "--package=node@22.23.4", "node", "-p", "process.execPath"],
  root,
);
const node22 = node22Lookup.stdout
  .trim()
  .split("\n")
  .findLast((line) => line.startsWith("/") && line.endsWith("/node"));
if (!node22) throw new Error(`Node 22 binary was not resolved: ${node22Lookup.stdout}`);
for (const version of ["3.5.25", "3.5.44"]) {
  const directory = await mkdtemp(resolve(tmpdir(), "muvra-consumer-"));
  const manifest = {
    private: true,
    type: "module",
    dependencies: { muvra: `file:${archive}`, vue: version },
    devDependencies: {
      typescript: "5.9.3",
      "@vue/server-renderer": version,
      rxjs: "7.8.2",
      "vue-tsc": "3.3.14",
      esbuild: "0.25.12",
    },
  };
  await writeFile(resolve(directory, "package.json"), JSON.stringify(manifest, null, 2));
  await writeFile(resolve(directory, "smoke.mjs"), smoke);
  await writeFile(resolve(directory, "consumer.mts"), declarations);
  await writeFile(
    resolve(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        skipLibCheck: false,
      },
      include: ["consumer.mts"],
    }),
  );
  const installation = await run("pnpm", ["install", "--ignore-scripts"], directory);
  const types = await run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], directory);
  const runtime = await run(process.execPath, ["smoke.mjs"], directory);
  const runtime22 = await run(node22, ["smoke.mjs"], directory);
  await mkdir(resolve(directory, "tests"), { recursive: true });
  for (const name of [
    "vue.test.mjs",
    "helpers.mjs",
    "sfc.test.mjs",
    "sfc-animation.test.mjs",
    "sfc-layers.test.mjs",
    "layers.test.mjs",
    "extensions-vue.test.mjs",
  ]) {
    const source = (await readFile(resolve(root, "tests", name), "utf8")).replaceAll(
      '"../dist/index.js"',
      '"muvra"',
    );
    await writeFile(
      resolve(directory, "tests", name),
      source.replaceAll('"../dist/extensions/backdrop.js"', '"muvra/extensions/backdrop"'),
    );
  }
  await cp(resolve(root, "tests/sfc"), resolve(directory, "tests/sfc"), { recursive: true });
  await mkdir(resolve(directory, "demo"), { recursive: true });
  await cp(resolve(root, "demo/props.ts"), resolve(directory, "demo/props.ts"));
  await cp(resolve(root, "demo/effects.ts"), resolve(directory, "demo/effects.ts"));
  await cp(resolve(root, "demo/layers.ts"), resolve(directory, "demo/layers.ts"));
  await cp(resolve(root, "demo/transitions"), resolve(directory, "demo/transitions"), {
    recursive: true,
  });
  await mkdir(resolve(directory, "scripts"), { recursive: true });
  for (const name of ["sfc-plugin.mjs", "sfc-check.mjs"])
    await cp(resolve(root, "scripts", name), resolve(directory, "scripts", name));
  const sfcTypes = await run(process.execPath, ["scripts/sfc-check.mjs"], directory);
  const sfcTypes22 = await run(node22, ["scripts/sfc-check.mjs"], directory);
  const integration = await run(
    process.execPath,
    [
      "--test",
      "tests/vue.test.mjs",
      "tests/sfc.test.mjs",
      "tests/sfc-animation.test.mjs",
      "tests/sfc-layers.test.mjs",
      "tests/layers.test.mjs",
      "tests/extensions-vue.test.mjs",
    ],
    directory,
  );
  const integration22 = await run(
    node22,
    [
      "--test",
      "tests/vue.test.mjs",
      "tests/sfc.test.mjs",
      "tests/sfc-animation.test.mjs",
      "tests/sfc-layers.test.mjs",
      "tests/layers.test.mjs",
      "tests/extensions-vue.test.mjs",
    ],
    directory,
  );
  report.consumers.push({
    vue: version,
    directory,
    installation,
    types,
    runtime,
    runtime22,
    sfcTypes,
    sfcTypes22,
    integration,
    integration22,
  });
  console.log(
    `Isolated package consumer passed: Vue ${version}, ${runtime.stdout.trim()}, ${runtime22.stdout.trim()}`,
  );
}
await writeFile(
  resolve(root, "reports/consumer-results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
