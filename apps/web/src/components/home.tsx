"use client";

import { useEffect, useState } from "react";
import { EventsList } from "./events-list";
import { type EstelaUser, LoginPanel } from "./login-panel";

/** Holds the Estela session shared by the login panel and the event list. */
export function Home() {
  const [user, setUser] = useState<EstelaUser | null>(null);
  const [checked, setChecked] = useState(false);

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
      <EventsList signedIn={user !== null} />
    </>
  );
}
