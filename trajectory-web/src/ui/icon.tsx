// Line icons from trajectoryapp.org (24x24, 1.8 stroke, round caps), the same set the mobile app draws.

import type { CSSProperties } from "react";

type Shape =
  | { d: string }
  | { rect: { x: number; y: number; w: number; h: number; r: number } }
  | { circle: { cx: number; cy: number; r: number; fill?: boolean } };

const ICONS = {
  cal: [{ rect: { x: 3.5, y: 5, w: 17, h: 15, r: 3 } }, { d: "M8 3v4M16 3v4M3.5 10h17" }],
  today: [{ rect: { x: 3.5, y: 5, w: 17, h: 15, r: 3 } }, { d: "M8 3v4M16 3v4M3.5 10h17M12 13.5v2.6l1.8 1" }],
  list: [{ d: "M9 6h11M9 12h11M9 18h11" }, { d: "m3.5 6 1.2 1.2L7 4.8M3.5 12l1.2 1.2L7 10.8M3.5 18l1.2 1.2L7 16.8" }],
  cap: [{ d: "m2.5 9 9.5-5 9.5 5-9.5 5z" }, { d: "M6 11.2V16c0 1.4 2.7 3 6 3s6-1.6 6-3v-4.8M21.5 9v5.5" }],
  book: [{ d: "M5 4.5h11a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z" }, { d: "M5 17a3 3 0 0 1 3-3h11" }],
  spark: [{ d: "M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9z" }, { d: "M19 3v3M17.5 4.5h3" }],
  refresh: [{ d: "M20 12a8 8 0 1 1-2.6-5.9" }, { d: "M20 4v4.5h-4.5" }],
  arrow: [{ d: "M5 12h14M13 6l6 6-6 6" }],
  lock: [{ rect: { x: 4.5, y: 10.5, w: 15, h: 10, r: 3 } }, { d: "M8 10.5V8a4 4 0 0 1 8 0v2.5" }],
  shield: [{ d: "M12 3 4.5 6v5.5c0 4.5 3.1 8 7.5 9.5 4.4-1.5 7.5-5 7.5-9.5V6z" }, { d: "m9 12 2.2 2.2L15.5 10" }],
  phone: [{ rect: { x: 6.5, y: 2.5, w: 11, h: 19, r: 3 } }, { d: "M10.5 18.5h3" }],
  trash: [{ d: "M4 7h16M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" }],
  check: [{ d: "m5 12.5 4.5 4.5L19 7.5" }],
  plus: [{ d: "M12 5v14M5 12h14" }],
  minus: [{ d: "M5 12h14" }],
  work: [{ rect: { x: 3.5, y: 7.5, w: 17, h: 12, r: 3 } }, { d: "M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17" }],
  link: [{ d: "M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" }, { d: "M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" }],
  file: [{ d: "M6.5 3h7l4.5 4.5V20a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" }, { d: "M13.5 3v4.5H18M9 12.5h6M9 16h6" }],
  moon: [{ d: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" }],
  test: [{ rect: { x: 4.5, y: 3.5, w: 15, h: 17, r: 3 } }, { d: "m8.5 9 1.5 1.5 3-3M8.5 15h7" }],
  flag: [{ d: "M6 21V4M6 5h11l-2 4 2 4H6" }],
  settings: [{ d: "M4 7h9M17 7h3M4 17h3M11 17h9" }, { circle: { cx: 15, cy: 7, r: 2.2 } }, { circle: { cx: 9, cy: 17, r: 2.2 } }],
  chevronLeft: [{ d: "m14.5 5.5-6.5 6.5 6.5 6.5" }],
  chevronRight: [{ d: "m9.5 5.5 6.5 6.5-6.5 6.5" }],
  chevronDown: [{ d: "m5.5 9.5 6.5 6.5 6.5-6.5" }],
  close: [{ d: "M6.5 6.5l11 11M17.5 6.5l-11 11" }],
  clock: [{ circle: { cx: 12, cy: 12, r: 8.5 } }, { d: "M12 7.5V12l3 2" }],
  bolt: [{ d: "M13 3 5.5 13.5h5.5L10 21l8-10.5h-5.5z" }],
  bell: [{ d: "M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" }, { d: "M10 20.5h4" }],
  upload: [{ d: "M12 15V4M7.5 8.5 12 4l4.5 4.5" }, { d: "M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" }],
  camera: [{ rect: { x: 3.5, y: 7, w: 17, h: 12.5, r: 3 } }, { d: "M9 7l1.5-2.5h3L15 7" }, { circle: { cx: 12, cy: 13.2, r: 3.3 } }],
  image: [{ rect: { x: 3.5, y: 4.5, w: 17, h: 15, r: 3 } }, { circle: { cx: 9, cy: 10, r: 1.6 } }, { d: "m20.5 16-5-5L6 19.5" }],
  text: [{ d: "M5 6h14M5 10h14M5 14h9M5 18h6" }],
  sun: [{ circle: { cx: 12, cy: 12, r: 4 } }, { d: "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" }],
  user: [{ circle: { cx: 12, cy: 8.5, r: 3.8 } }, { d: "M4.5 20.5a7.5 7.5 0 0 1 15 0" }],
  edit: [{ d: "M4 20h4L19 9l-4-4L4 16z" }, { d: "m13.5 6.5 4 4" }],
  more: [{ circle: { cx: 5.5, cy: 12, r: 1.3, fill: true } }, { circle: { cx: 12, cy: 12, r: 1.3, fill: true } }, { circle: { cx: 18.5, cy: 12, r: 1.3, fill: true } }],
  send: [{ d: "M4.5 12 20 4.5 14.5 20l-3-6.5z" }, { d: "m11.5 13.5 3-3" }],
  warning: [{ d: "M12 4 2.8 19.5h18.4z" }, { d: "M12 10v4.2M12 17h.01" }],
  info: [{ circle: { cx: 12, cy: 12, r: 8.5 } }, { d: "M12 11v5M12 8h.01" }],
  mail: [{ rect: { x: 3.5, y: 5.5, w: 17, h: 13, r: 3 } }, { d: "m4.5 7.5 7.5 5.5 7.5-5.5" }],
  external: [{ d: "M14 4.5h5.5V10M19.5 4.5l-8 8" }, { d: "M18 13.5v5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h5" }],
  download: [{ d: "M12 4v11M7.5 10.5 12 15l4.5-4.5" }, { d: "M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" }],
  repeat: [{ d: "M17 3.5l3 3-3 3M20 6.5H8a4 4 0 0 0-4 4v.5" }, { d: "M7 20.5l-3-3 3-3M4 17.5h12a4 4 0 0 0 4-4V13" }],
  play: [{ d: "M8 5.5v13l10-6.5z" }],
  pause: [{ d: "M9 5.5v13M15 5.5v13" }],
  stop: [{ rect: { x: 6, y: 6, w: 12, h: 12, r: 2.5 } }],
  undo: [{ d: "M9 14 4 9l5-5" }, { d: "M4 9h10.5a5.5 5.5 0 0 1 0 11H11" }],
  search: [{ circle: { cx: 11, cy: 11, r: 6.5 } }, { d: "m16 16 4.5 4.5" }],
  calPlus: [{ rect: { x: 3.5, y: 5, w: 17, h: 15, r: 3 } }, { d: "M8 3v4M16 3v4M3.5 10h17M12 12.5v5M9.5 15h5" }],
  calSync: [{ rect: { x: 3.5, y: 5, w: 17, h: 15, r: 3 } }, { d: "M8 3v4M16 3v4M3.5 10h17" }, { d: "M15 14.5a3 3 0 1 1-1-2.2M15 11.5v1.5h-1.5" }],
  star: [{ d: "m12 4 2.3 4.9 5.2.6-3.9 3.6 1.1 5.2L12 15.7l-4.7 2.6 1.1-5.2L4.5 9.5l5.2-.6z" }],
  target: [{ circle: { cx: 12, cy: 12, r: 8.5 } }, { circle: { cx: 12, cy: 12, r: 4.5 } }, { circle: { cx: 12, cy: 12, r: 1, fill: true } }],
  layers: [{ d: "m12 4 8.5 4.5L12 13 3.5 8.5z" }, { d: "m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" }],
  gauge: [{ d: "M4.5 17a8 8 0 1 1 15 0" }, { d: "m12 13 3.5-4" }],
  grid: [{ rect: { x: 4, y: 4, w: 6.5, h: 6.5, r: 1.8 } }, { rect: { x: 13.5, y: 4, w: 6.5, h: 6.5, r: 1.8 } }, { rect: { x: 4, y: 13.5, w: 6.5, h: 6.5, r: 1.8 } }, { rect: { x: 13.5, y: 13.5, w: 6.5, h: 6.5, r: 1.8 } }],
  logout: [{ d: "M14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4" }, { d: "M10 8l-4 4 4 4M6 12h9" }],
  crown: [{ d: "M4 18h16M4.5 15.5 3.5 7l5 4 3.5-6 3.5 6 5-4-1 8.5z" }],
  pin: [{ d: "M9 4h6l-.8 5.2 3 2.8v1.5H6.8V12l3-2.8z" }, { d: "M12 13.5V20" }],
  key: [{ circle: { cx: 8, cy: 14, r: 4 } }, { d: "m11 11 8.5-8.5M16 6l2.5 2.5M13.5 8.5 16 11" }],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, color = "currentColor", strokeWidth = 1.8, style, className }: { name: IconName; size?: number; color?: string; strokeWidth?: number; style?: CSSProperties; className?: string }) {
  const shapes = ICONS[name] as Shape[];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" style={{ flexShrink: 0, display: "block", ...style }} className={className}>
      {shapes.map((shape, index) => {
        if ("d" in shape) return <path key={index} d={shape.d} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" fill="none" />;
        if ("rect" in shape) {
          const r = shape.rect;
          return <rect key={index} x={r.x} y={r.y} width={r.w} height={r.h} rx={r.r} stroke={color} strokeWidth={strokeWidth} fill="none" />;
        }
        const c = shape.circle;
        return <circle key={index} cx={c.cx} cy={c.cy} r={c.r} stroke={c.fill ? "none" : color} strokeWidth={strokeWidth} fill={c.fill ? color : "none"} />;
      })}
    </svg>
  );
}

/** Rounded square icon well (the website's `.ic`): tinted background with the icon centred. */
export function IconWell({ name, color, background, size = 36, iconSize, radius }: { name: IconName; color: string; background: string; size?: number; iconSize?: number; radius?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: radius ?? Math.round(size * 0.31), background, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <Icon name={name} size={iconSize ?? Math.round(size * 0.5)} color={color} />
    </div>
  );
}
