import { NextResponse } from "next/server";
import { generateMetricsResponse } from "@/lib/monitoring/metrics";

/**
 * GET /api/metrics
 *
 * Returns Prometheus-formatted metrics for scraping.
 * Content-Type is set to text/plain so Prometheus can parse the response.
 *
 * Metrics include:
 *  - Default Node.js metrics (memory, event loop lag, GC, etc.)
 *  - HTTP request duration histogram (http_request_duration_seconds)
 *  - HTTP request counter (http_requests_total)
 *  - HTTP error counter (http_errors_total)
 *  - Process memory gauge (process_memory_bytes)
 */
export async function GET() {
  try {
    const metrics = await generateMetricsResponse();
    return new NextResponse(metrics, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to generate metrics";
    console.error("[metrics]", message);
    return NextResponse.json(
      { error: "Failed to generate metrics" },
      { status: 500 },
    );
  }
}
