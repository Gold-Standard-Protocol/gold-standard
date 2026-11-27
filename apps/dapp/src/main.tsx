import './polyfills';
import { StrictMode } from 'react';
import * as ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import App from './app/app';
import { FramedNotice, framingVerdict } from './app/frameGuard';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
// Framed by anything but Safe{Wallet}, the app does not render,
// so no wallet connects and no control can be disguised. This runs from the bundle: the
// CSP has no 'unsafe-inline', and IPFS and ENS gateways cannot send frame-ancestors.
root.render(
  framingVerdict(window, document.referrer) === 'untrusted' ? (
    <FramedNotice href={window.location.href} />
  ) : (
    <StrictMode>
      {/* React Router 7 makes the two behaviours the v6 future flags opted into the
          defaults: router state updates are wrapped in startTransition (useTransitions
          left undefined) and splat routes resolve relative paths the v7 way. */}
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>
  )
);
