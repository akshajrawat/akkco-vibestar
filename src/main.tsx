import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { App } from "./app/App";
import "./styles/index.css";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user" transition={{ duration: 0.16 }}>
      <App />
    </MotionConfig>
  </StrictMode>,
);
