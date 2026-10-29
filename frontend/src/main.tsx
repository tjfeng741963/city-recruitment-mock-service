import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/google-sans-flex";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/google-sans-code";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/ui-kit.css";
import "./styles/ui-patterns.css";
import "./styles/showcase.css";
import "./styles/reception.css";
import "./styles/modules.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
