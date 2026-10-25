"use client";

import { useEffect, useState } from "react";
import { EventsList } from "./events-list";
import { type EstelaUser, LoginPanel } from "./login-panel";
import { MyTickets } from "./my-tickets";

/** Holds the Estela session shared by the login panel, the events and the tickets. */
export function Home() {
  const [user, setUser] = useState<EstelaUser | null>(null);
  const [checked, setChecked] = useState(false);
  // Bumped after a purchase so "Mis tickets" reloads.
  const [ticketsVersion, setTicketsVersion] = useState(0);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return <p className="text-sm opacity-70">Cargando…</p>;

  return (
    <>
      <LoginPanel user={user} onUserChange={setUser} />
      <EventsList signedIn={user !== null} onPurchased={() => setTicketsVersion((v) => v + 1)} />
      {user && <MyTickets refreshKey={ticketsVersion} />}
    </>
  );
}
