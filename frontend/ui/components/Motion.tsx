import { animate, motion, useReducedMotion, type Variants } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";

export const EASE_SIGNATURE = [0.32, 0.72, 0, 1] as const;
const STAGGER = 0.06;

const container: Variants = { hidden: {}, shown: { transition: { staggerChildren: STAGGER } } };
const item: Variants = {
  hidden: { opacity: 0, y: 12 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.42, ease: EASE_SIGNATURE } },
};

export function Reveal({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "ul" }) {
  const reduce = useReducedMotion();
  const Tag = motion[as];
  return (
    <Tag className={className} variants={container} initial={reduce ? false : "hidden"} animate="shown">
      {children}
    </Tag>
  );
}

export function RevealItem({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "li" | "section" }) {
  const Tag = motion[as];
  return (
    <Tag className={className} variants={item}>
      {children}
    </Tag>
  );
}

const formatInt = (n: number) => Math.round(n).toLocaleString("zh-CN");

export function CountUp({ value, format = formatInt }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = from.current;
    from.current = value;
    if (reduce) {
      el.textContent = format(value);
      return;
    }
    const controls = animate(start, value, {
      duration: 0.8,
      ease: EASE_SIGNATURE,
      onUpdate: (n) => {
        el.textContent = format(n);
      },
    });
    return () => controls.stop();
  }, [value, reduce, format]);

  return <span ref={ref} className="ui-num">{format(reduce ? value : 0)}</span>;
}
