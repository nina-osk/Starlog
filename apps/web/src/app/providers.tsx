"use client";

import { PollarProvider } from "@pollar/react";

// Google/GitHub sign-in opens in a new tab; when it's done the provider sends that
// tab here, while the original tab completes the login. Must match an allowed
// redirect URI in Pollar (Build > Domains).
const OAUTH_CALLBACK_PATH = "/oauth/callback";

// Pollar handles sign-in (Google / email) and the user's wallet. The publishable
// key also selects the network: pub_testnet_... keys run on Stellar testnet.
export function Providers({ children }: { children: React.ReactNode }) {
  const oauthRedirectUri =
    typeof window !== "undefined" ? `${window.location.origin}${OAUTH_CALLBACK_PATH}` : undefined;
  return (
    <PollarProvider
      client={{ apiKey: process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY!, oauthRedirectUri }}
    >
      {children}
    </PollarProvider>
  );
}
