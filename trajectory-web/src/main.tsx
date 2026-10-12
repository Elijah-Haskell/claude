import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { AIConsentProvider } from "./state/ai-consent";
import { AppProvider } from "./state/app-provider";
import { ModalProvider } from "./state/modal-context";
import { SubscriptionProvider } from "./state/subscription-context";
import "./styles.css";
import { ThemeProvider } from "./ui/theme";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AppProvider>
        <AIConsentProvider>
          <SubscriptionProvider>
            <ModalProvider>
              <App />
            </ModalProvider>
          </SubscriptionProvider>
        </AIConsentProvider>
      </AppProvider>
    </ThemeProvider>
  </StrictMode>,
);
