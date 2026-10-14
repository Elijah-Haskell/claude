import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";
import { AIConsentProvider } from "./state/ai-consent";
import { AppProvider } from "./state/app-provider";
import { ModalProvider } from "./state/modal-context";
import { SubscriptionProvider } from "./state/subscription-context";
// The fonts ship with the app (no request to a font service): Poppins for text, JetBrains Mono for figures.
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "@fontsource/poppins/800.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
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
