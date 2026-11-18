// "Who can see this matter": the matter page's control for restricting a matter to named
// people (an ethical wall, a sensitive client). The server enforces it everywhere
// (src/auth/access.ts); this card shows the list and lets attorneys and administrators
// change it with PUT /api/matters/:id/access {userIds} (an empty list lifts it).

import { h, replace, modal, toast } from "../dom.js";
import { get, put } from "../api.js";
import { state, users } from "../state.js";
import { card, button, avatar, pill } from "../ui/components.js";

const canChange = () => ["admin", "attorney"].includes(state.account?.role);

export function accessCard(matterId, { onChange } = {}) {
  const body = h("div.matter-access-body", h("p.muted.small", "Loading…"));
  const el = card({ title: "Who can see this matter", icon: "lock", className: "rail-card matter-access", body });
  let current = { restricted: false, users: [] };

  async function load() {
    try {
      current = await get(`/matters/${matterId}/access`);
      draw();
    } catch (err) {
      replace(body, h("p.muted.small", `Couldn't load: ${err.message}`));
    }
  }

  function draw() {
    replace(
      body,
      current.restricted
        ? [
            h("p.matter-access-state", pill("Restricted", "warning"), h("span", `${current.users.length} ${current.users.length === 1 ? "person" : "people"}`)),
            h(
              "ul.plain.matter-access-list",
              current.users.map((u) => h("li", avatar(u.name, { size: "xs" }), h("span", u.name))),
            ),
            h("p.rail-note", "Administrators can always see every matter. Everyone else gets “not found”, everywhere in Lawdesk."),
          ]
        : [h("p.matter-access-state", pill("Everyone at the firm", "neutral", { dot: false })), h("p.rail-note", "Restrict it to set up an ethical wall or protect a sensitive client.")],
      canChange()
        ? h("div.matter-access-actions", button(current.restricted ? "Change who can see it" : "Restrict access", { size: "sm", icon: "lock", onclick: openDialog }))
        : null,
    );
  }

  function openDialog() {
    const chosen = new Set(current.users.map((u) => u.user_id));
    if (!current.restricted && state.me != null) chosen.add(state.me);
    const people = users()
      .filter((u) => u.active !== 0 || chosen.has(u.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    const boxes = people.map((u) => [u.id, h("input", { type: "checkbox", value: u.id, checked: chosen.has(u.id) })]);
    const err = h("p.error-text", { role: "alert" });
    const save = async (ids) => {
      try {
        current = await put(`/matters/${matterId}/access`, { userIds: ids });
        dlg.close();
        toast(current.restricted ? `Only ${current.users.map((u) => u.name).join(", ")} (and administrators) can see this matter` : "Everyone at the firm can see this matter again");
        draw();
        onChange?.();
      } catch (ex) {
        err.textContent = ex.message;
      }
    };
    const form = h(
      "form.modal-body.form-grid",
      {
        onsubmit: (e) => {
          e.preventDefault();
          const ids = boxes.filter(([, c]) => c.checked).map(([uid]) => uid);
          if (!ids.length) {
            err.textContent = "Pick at least one person, or choose “Let everyone see it”.";
            return;
          }
          save(ids);
        },
      },
      h("p.muted", "Only the people ticked here, and administrators, will see this matter, its tasks, documents, billing, calendar entries and messages. You stay on the list."),
      h(
        "fieldset.matter-access-pick",
        h("legend", "People who can see it"),
        h("div.dep-pick-list", boxes.map(([uid, c]) => h("label.check-line", c, h("span", people.find((p) => p.id === uid).name)))),
      ),
      err,
      h(
        "div.form-actions",
        current.restricted ? h("button.btn.matter-access-lift", { type: "button", onclick: () => save([]) }, "Let everyone see it") : null,
        h("button.btn", { type: "button", onclick: () => dlg.close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, "Save"),
      ),
    );
    const dlg = modal("Who can see this matter", form);
  }

  el.reload = load;
  load();
  return el;
}
