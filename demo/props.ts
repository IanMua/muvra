import { createApp } from "vue";
import InferenceHost from "../tests/sfc/InferenceHost.vue";
import { stack } from "../tests/sfc/catalog.js";

// 浏览器只观察公开快照；页面动作全部由真实 SFC 宿主按钮执行。
await stack.ready;
createApp(InferenceHost).mount("#app");
Object.assign(window, { propsLab: { stack } });
