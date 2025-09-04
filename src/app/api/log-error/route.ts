import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { error, context } = body;

    if (!error) {
      return NextResponse.json(
        { message: "Missing 'error' in request body." },
        { status: 400 },
      );
    }

    console.error(
      `[Client Error]${context ? " [" + context + "]" : ""}:`,
      error,
    );

    return NextResponse.json({ message: "Error logged successfully." });
  } catch (e) {
    console.error("[API log-error] Failed to log error:", e);
    return NextResponse.json(
      { message: "Failed to log error." },
      { status: 500 },
    );
  }
}
