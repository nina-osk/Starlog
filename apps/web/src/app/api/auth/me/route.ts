import { NextResponse } from "next/server";
import { currentSession } from "@/server/auth/current-user";

/** The signed-in session, or null. Not being signed in is a normal answer, not an error. */
export async function GET() {
  return NextResponse.json(await currentSession());
}
