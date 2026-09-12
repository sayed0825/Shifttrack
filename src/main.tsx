import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App.tsx';
import ErrorFallback from './components/ErrorFallback.tsx';
import { scrubSentryEvent } from './lib/sentryScrub.ts';
import 'leaflet/dist/leaflet.css';
import './index.css';

// Initialised before the app renders, so a crash during the very first
// render is still captured.
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  // No replayIntegration() — this app shows payroll data, employee
  // locations and manager notes, and session replay records what users
  // do on screen. Tracing only, at a low sample rate.
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: 0.1,
  // Never send IP/user identity — the app never calls Sentry.setUser()
  // anyway, but this is belt and braces.
  sendDefaultPii: false,
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>
);
