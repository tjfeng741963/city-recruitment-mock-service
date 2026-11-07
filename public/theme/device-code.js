{
  // 设备弹窗增强层：不改 Vue 源码，靠 DOM 注入给「新增设备」加可用的设备码生成，
  // 并把知识库链路用不到的高级字段收起来。Vue 重建弹窗时 MutationObserver 会重新装饰。
  const DIALOG_TITLES = ["新增设备", "编辑设备"];
  const CODE_LABEL = "设备码";
  // 「基本信息」之外的分组对知识库链路都用不到：新用户只该看到设备码/名称/模式。
  const ADVANCED_SECTIONS = [
    "消息合并",
    "追问配置",
    "静默时段",
    "事件检测",
    "面试提醒",
    "YML 工作流",
  ].map((label) => label.replace(/\s+/g, ""));
  // 基本分组里对知识库链路没用的字段，单独按 label 收起（它们在「基本信息」组内）。
  const ADVANCED_LABELS = ["分配账号", "Dify URL", "Dify Key"].map((label) =>
    label.replace(/\s+/g, ""),
  );
  // 去掉容易看错的 0/O/1/I/L，用户要照着抄进 config.json。
  const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const CODE_PREFIX = "AG-";
  const CODE_LENGTH = 6;
  const HINT_DEFAULT =
    "这台设备的唯一编号。客户端 config.json 里的 device_code 填这个值；" +
    "留空则由客户端自动注册（pc-xxxxxxxxxxxx）。";
  const HINT_DONE = "已填入。把这个码填到客户端的 device_code 即可。";

  function randomCode() {
    const bytes = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(bytes);
    let out = "";
    for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
    return CODE_PREFIX + out;
  }

  // 直接写 input.value 不会触发 Vue 的 v-model，必须走原生 setter 再派发 input 事件。
  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // 标签比较统一规范化：去掉必填星号、中英文冒号与所有空白，
  // 否则 "Dify URL" 会变成 "DifyURL" 而永远匹配不上配置里的写法。
  const normalizeLabel = (text) =>
    String(text ?? "")
      .replace(/[：:]/g, "")
      .replace(/\s+/g, "")
      .trim();
  const labelText = (item) =>
    normalizeLabel(item.querySelector(".el-form-item__label")?.textContent);

  function decorateCodeField(dialog) {
    for (const item of dialog.querySelectorAll(".el-form-item")) {
      if (item.dataset.rkCode === "1") continue;
      if (labelText(item) !== CODE_LABEL) continue;

      const content = item.querySelector(".el-form-item__content");
      const input = content?.querySelector("input.el-input__inner");
      if (!content || !input) continue;

      item.dataset.rkCode = "1";
      content.style.display = "flex";
      content.style.flexWrap = "wrap";
      content.style.alignItems = "center";
      content.style.gap = "8px";
      const inputBox = input.closest(".el-input");
      if (inputBox) inputBox.style.flex = "1 1 auto";

      const hint = document.createElement("div");
      hint.className = "rk-code-hint";
      hint.textContent = HINT_DEFAULT;
      hint.style.cssText =
        "flex-basis:100%;font-size:12px;line-height:1.6;color:var(--el-text-color-secondary,#909399);margin-top:2px";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "el-button el-button--default el-button--small rk-code-generate";
      button.textContent = "自动生成";
      button.style.cssText = "flex:0 0 auto;white-space:nowrap";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const code = randomCode();
        setInputValue(input, code);
        input.focus();
        button.textContent = "重新生成";
        hint.textContent = `${code} —— ${HINT_DONE}`;
        hint.style.color = "var(--el-color-success,#67c23a)";
      });

      // 编辑已有设备时设备码是锁定态，生成按钮没有意义。
      const syncDisabled = () => {
        button.style.display = input.disabled ? "none" : "";
        hint.style.display = input.disabled ? "none" : "";
      };
      syncDisabled();
      new MutationObserver(syncDisabled).observe(input, {
        attributes: true,
        attributeFilter: ["disabled"],
      });

      if (inputBox && inputBox.parentNode === content) {
        inputBox.insertAdjacentElement("afterend", button);
      } else {
        content.appendChild(button);
      }
      content.appendChild(hint);
    }
  }

  function decorateAdvancedSections(dialog) {
    const form = dialog.querySelector("form.el-form") ?? dialog;
    if (form.dataset.rkAdvanced === "1") return;

    const hidden = [];
    // 1) 基本分组里用不到的字段（分配账号 / Dify URL / Dify Key）
    for (const item of form.querySelectorAll(".el-form-item")) {
      if (ADVANCED_LABELS.includes(labelText(item))) hidden.push(item);
    }
    // 2) 「消息合并」「追问配置」整组（含该分组下所有兄弟节点，直到下一个分隔线）
    const dividers = [...form.querySelectorAll(".el-divider")];
    const advanced = dividers.filter((divider) =>
      ADVANCED_SECTIONS.includes(
        normalizeLabel(divider.querySelector(".el-divider__text")?.textContent),
      ),
    );
    for (const divider of advanced) {
      hidden.push(divider);
      let node = divider.nextElementSibling;
      while (node && !node.classList.contains("el-divider")) {
        hidden.push(node);
        node = node.nextElementSibling;
      }
    }
    if (!hidden.length) return;
    form.dataset.rkAdvanced = "1";

    // 折叠按钮放在第一个要隐藏的节点之前，保证隐藏项都在按钮下方。
    const anchor = hidden.reduce((first, node) =>
      first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING ? node : first,
    );

    // 首次装饰默认收起：新用户不需要看见 Dify / 合并 / 追问这些知识库链路用不到的项。
    let collapsed = true;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "rk-advanced-toggle";
    toggle.style.cssText =
      "display:block;margin:8px 0;padding:2px 0;background:none;border:0;cursor:pointer;" +
      "font-size:12px;color:var(--el-color-primary,#409eff)";
    anchor.parentNode.insertBefore(toggle, anchor);

    const apply = () => {
      toggle.textContent = collapsed ? "▸ 高级设置（一般不用改）" : "▾ 收起高级设置";
      for (const node of hidden) node.style.display = collapsed ? "none" : "";
    };
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      collapsed = !collapsed;
      apply();
    });
    apply();
  }

  function decorate(dialog) {
    decorateCodeField(dialog);
    decorateAdvancedSections(dialog);
  }

  function scan() {
    for (const dialog of document.querySelectorAll(".el-dialog")) {
      const title = (dialog.querySelector(".el-dialog__title")?.textContent ?? "").trim();
      if (DIALOG_TITLES.includes(title)) decorate(dialog);
    }
  }

  function start() {
    let frame = 0;
    // 监听 documentElement 而不是 body：这个脚本在 <head> 里同步执行，
    // 此时 document.body 还是 null，直接 observe 会抛 TypeError 并让整段注入失效。
    new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }

  window.__rkDeviceCode = { randomCode, scan };
}
