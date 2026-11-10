import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UiKitShowcase } from "./UiKitShowcase";
import "@ui/theme";
import "./showcase.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <UiKitShowcase />
  </StrictMode>,
);
