// 编译版岗位表单只提交 store_name；在编辑页补充真正的工厂归属。
{
  async function api(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      headers: { authorization: `Bearer ${localStorage.getItem("token") || ""}`, "content-type": "application/json" },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || `HTTP ${response.status}`);
    return body;
  }

  function syncDisplayName(form, name) {
    const item = [...form.querySelectorAll(".el-form-item")].find((element) => element.querySelector("label")?.textContent.trim() === "工厂名称");
    const input = item?.querySelector("input");
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async function mount() {
    const match = location.pathname.match(/^\/service-positions\/(\d+)\/edit\/?$/);
    if (!match) return;
    const form = document.querySelector("#app form.el-form");
    if (!form || document.getElementById("rk-position-factory")) return;
    const id = match[1];
    const card = document.createElement("section");
    card.id = "rk-position-factory";
    card.setAttribute("aria-label", "岗位工厂归属");
    card.style.cssText = "margin:0 0 20px;padding:16px 18px;border:1px solid var(--gl-edge);border-radius:var(--gl-r-card);background:linear-gradient(180deg,rgba(255,255,255,.92),rgba(250,252,255,.78));backdrop-filter:var(--gl-blur);-webkit-backdrop-filter:var(--gl-blur);box-shadow:var(--gl-shadow)";
    const title = document.createElement("h3");
    title.textContent = "岗位工厂归属";
    title.style.cssText = "margin:0 0 8px;font-size:16px;color:var(--rk-ink-1)";
    const note = document.createElement("p");
    note.textContent = "设备绑定工厂后，只能查询归属于该工厂的岗位。下面的工厂名称文字不能代替归属设置。";
    note.style.cssText = "font-size:13px;line-height:1.6;color:var(--rk-ink-2)";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "正在读取工厂归属…";
    const label = document.createElement("label");
    label.textContent = "所属工厂 ";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "所属工厂");
    select.style.cssText = "max-width:100%;min-height:34px;padding:4px 8px;margin-right:8px";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存工厂归属";
    save.style.cssText = "min-height:34px;padding:4px 16px;border:0;border-radius:999px;background:var(--rk-grad-primary);color:#fff;font-weight:600;cursor:pointer";
    select.disabled = save.disabled = true;
    label.append(select);
    card.append(title, note, label, save, status);
    form.before(card);
    const url = `/api/v1/service-positions/${id}/factory-binding`;
    let current = null;
    function render(data) {
      current = data.factory_id;
      select.replaceChildren();
      select.add(new Option("未设置工厂归属", ""));
      for (const factory of data.factories) {
        const option = new Option(`${factory.factory_name}${factory.is_active ? "" : "（已停用）"}`, String(factory.id));
        option.disabled = !factory.is_active;
        select.add(option);
      }
      select.value = current === null ? "" : String(current);
      status.textContent = `${data.city_name} · ${data.factory_name || "尚未归属工厂，绑定设备无法查询此岗位"}`;
      select.disabled = false;
      save.disabled = true;
    }
    select.addEventListener("change", () => {
      save.disabled = select.value === (current === null ? "" : String(current));
    });
    save.addEventListener("click", async () => {
      save.disabled = select.disabled = true;
      try {
        const data = await api(url, { method: "PUT", body: JSON.stringify({ factory_id: select.value ? Number(select.value) : null }) });
        if (!card.isConnected || !location.pathname.match(new RegExp(`^/service-positions/${id}/edit/?$`))) return;
        syncDisplayName(form, data.factory_name);
        render(data);
        status.textContent = `已保存 · ${status.textContent}`;
      } catch (error) {
        status.textContent = `保存失败：${error.message}`;
        select.disabled = save.disabled = false;
      }
    });
    try { render(await api(url)); }
    catch (error) { status.textContent = `读取失败：${error.message}，请刷新页面重试`; }
  }
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; mount(); });
  }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", schedule);
  document.addEventListener("DOMContentLoaded", schedule, { once: true });
  schedule();
}
