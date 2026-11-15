// 此模块是 index.html 的应用入口：依赖加载完成后同步包装 setup，
// 让首次路由挂载也能看到新增列；单独追加 module 脚本会与路由加载竞争。
// 沿用现有 Vue 产物；bundle 更新后需同步这两个入口的文件名与导出别名。
import CandidateView from "/assets/CandidateView-BqRni_qH.js";
import { d as createVNode, w as withCtx } from "/assets/index-BGyFQL9Q.js";
import { addRegistrationColumn } from "./candidate-registration-table.js";

const originalSetup = CandidateView.setup;
CandidateView.setup = function (...args) {
  const render = originalSetup.apply(this, args);
  return function (...renderArgs) {
    const tree = render.apply(this, renderArgs);
    addRegistrationColumn(tree, createVNode, withCtx);
    return tree;
  };
};
