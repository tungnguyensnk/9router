import { NextResponse } from "next/server";
import { getUsageStats, deleteUsageHistory } from "@/lib/usageDb";

export async function GET() {
  try {
    const stats = await getUsageStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const body = await request.json();
    const { mode = "all", customRange = null } = body;

    const validModes = ["all", "1d", "7d", "30d", "custom"];
    if (!validModes.includes(mode)) {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }

    if (mode === "custom" && (!customRange?.startDate || !customRange?.endDate)) {
      return NextResponse.json({ error: "Custom range requires startDate and endDate" }, { status: 400 });
    }

    await deleteUsageHistory(mode, customRange);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting usage history:", error);
    return NextResponse.json({ error: "Failed to delete usage history" }, { status: 500 });
  }
}
