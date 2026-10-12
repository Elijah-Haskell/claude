/**
 * Alerts and questions on the web (what Alert.alert is on the iPhone): one queue, outside React, so the account layer,
 * the saved plan and the subscription provider can ask without a component of their own; <DialogHost /> (mounted once
 * in the app) shows the first one in a sheet (a centred dialog on a wide screen) and resolves the promise with the
 * button that was pressed.
 */
import { useSyncExternalStore, type ReactNode } from "react";

import { Icon } from "../ui/icon";
import { PrimaryButton } from "../ui/primitives";
import { Sheet, SheetBody } from "../ui/sheet";
import { useColors } from "../ui/theme";

export interface DialogButton {
  text: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
}

export interface DialogRequest {
  title: string;
  message?: string;
  buttons: DialogButton[];
  /** Closing the sheet without a button (Escape, the backdrop) is allowed and resolves to null. Default true. */
  cancelable?: boolean;
  /** A line in mono over the title ("Trajectory Pro"). */
  eyebrow?: string;
  icon?: "info" | "warning" | "crown" | "check";
}

interface Pending extends DialogRequest {
  id: number;
  resolve: (pressed: string | null) => void;
}

let queue: Pending[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Shows an alert (queued behind any open one). Resolves to the pressed button's text, or null when dismissed. */
export function showAlert(request: DialogRequest): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { ...request, id: nextId++, resolve }];
    emit();
  });
}

/** A yes / no question as a promise. */
export async function confirmDialog(copy: { title: string; message: string; no: string; yes: string; destructive?: boolean; eyebrow?: string }): Promise<boolean> {
  const pressed = await showAlert({
    title: copy.title,
    message: copy.message,
    eyebrow: copy.eyebrow,
    icon: copy.destructive ? "warning" : "info",
    buttons: [
      { text: copy.yes, style: copy.destructive ? "destructive" : "default" },
      { text: copy.no, style: "cancel" },
    ],
  });
  return pressed === copy.yes;
}

/** An alert that only tells. */
export function tellDialog(title: string, message: string, button = "OK"): Promise<void> {
  return showAlert({ title, message, buttons: [{ text: button }] }).then(() => undefined);
}

function settle(id: number, pressed: string | null): void {
  const item = queue.find((entry) => entry.id === id);
  if (!item) return;
  queue = queue.filter((entry) => entry.id !== id);
  emit();
  item.resolve(pressed);
}

const getFirst = () => queue[0] ?? null;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Mount once. Shows the first queued dialog. */
export function DialogHost(): ReactNode {
  const current = useSyncExternalStore(subscribe, getFirst, () => null);
  const colors = useColors();
  if (!current) return null;
  const cancelable = current.cancelable !== false;
  const iconColor = current.icon === "warning" ? colors.gold : current.icon === "crown" ? colors.violet : current.icon === "check" ? colors.success : colors.peri;
  return (
    <Sheet open onClose={() => (cancelable ? settle(current.id, null) : undefined)} ariaLabel={current.title}>
      <SheetBody gap={12}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          {current.icon ? (
            <span style={{ width: 36, height: 36, borderRadius: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", background: `${iconColor}22`, flexShrink: 0 }}>
              <Icon name={current.icon} size={18} color={iconColor} />
            </span>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            {current.eyebrow ? <div className="eyebrow" style={{ color: colors.peri, marginBottom: 4 }}>{current.eyebrow}</div> : null}
            <h2 style={{ margin: 0, fontSize: 20, lineHeight: "26px", fontWeight: 700, letterSpacing: -0.3, color: colors.foreground }}>{current.title}</h2>
            {current.message ? <p style={{ margin: "8px 0 0", fontSize: 14.5, lineHeight: "21px", color: colors.muted, whiteSpace: "pre-line" }}>{current.message}</p> : null}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          {current.buttons.map((button) => (
            <PrimaryButton
              key={button.text}
              size="lg"
              fullWidth
              tone={button.style === "destructive" ? "danger" : button.style === "cancel" ? "ghost" : "primary"}
              label={button.text}
              onPress={() => {
                settle(current.id, button.text);
                button.onPress?.();
              }}
            />
          ))}
        </div>
      </SheetBody>
    </Sheet>
  );
}
