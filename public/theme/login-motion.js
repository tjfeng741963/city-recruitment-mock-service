const FINE = matchMedia("(hover: hover) and (pointer: fine)").matches;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (FINE && !REDUCED) {
  let frame = 0;
  window.addEventListener(
    "pointermove",
    (event) => {
      const page = document.querySelector(".login-page");
      if (!page || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        page.style.setProperty("--mx", (event.clientX / innerWidth).toFixed(3));
        page.style.setProperty("--my", (event.clientY / innerHeight).toFixed(3));
        const card = page.querySelector(".login-card");
        if (!card) return;
        const box = card.getBoundingClientRect();
        card.style.setProperty("--cx", `${event.clientX - box.left}px`);
        card.style.setProperty("--cy", `${event.clientY - box.top}px`);
      });
    },
    { passive: true },
  );
}
