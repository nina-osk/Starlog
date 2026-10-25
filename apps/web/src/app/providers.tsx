"use client";

import { PollarProvider } from "@pollar/react";

// Pollar handles sign-in (Google / email) and the user's wallet. The publishable
// key also selects the network: pub_testnet_... keys run on Stellar testnet.
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PollarProvider client={{ apiKey: process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY! }}>
      {children}
    </PollarProvider>
  );
}
