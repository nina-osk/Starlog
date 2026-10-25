import { NextResponse } from "next/server";
import { currentSession } from "@/server/auth/current-user";

export async function GET() {
  const session = await currentSession();
  if (!session) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }
  return NextResponse.json(session);
}
