import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@ui/theme";
import "./styles/app.css";
import "./styles/reception.css";
import "./styles/modules.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
