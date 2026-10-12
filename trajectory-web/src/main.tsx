import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { AppProvider } from "./state/app-provider";
import { ModalProvider } from "./state/modal-context";
import "./styles.css";
import { ThemeProvider } from "./ui/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AppProvider>
        <ModalProvider>
          <App />
        </ModalProvider>
      </AppProvider>
    </ThemeProvider>
  </StrictMode>,
);
