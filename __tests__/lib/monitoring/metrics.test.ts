import { beforeEach, describe, expect, it, vi } from "vitest";

// We'll test the metrics helpers by importing, but since prom-client registers
// global metrics that persist across test files, we do minimal imports here.
// The module-level metrics (httpRequestDuration, etc.) are tested via the API
// route tests; this file focuses on the helper functions that can be tested
// in isolation.

describe("metrics module helpers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("recordRequestMetrics", () => {
    it("should record a successful request without incrementing error counter", async () => {
      const { recordRequestMetrics, httpRequestsTotal, httpErrorsTotal, httpRequestDuration } =
        await import("@/lib/monitoring/metrics");

      // Set initial counts to 0
      httpRequestsTotal.reset();
      httpErrorsTotal.reset();
      httpRequestDuration.reset();

      recordRequestMetrics("GET", "/api/pools", 200, 0.05);

      const requestsAfter = await httpRequestsTotal.get();
      expect(requestsAfter.values).toHaveLength(1);
      expect(requestsAfter.values[0].labels).toMatchObject({
        method: "GET",
        path: "/api/pools",
        status: 200,
      });
      expect(requestsAfter.values[0].value).toBe(1);

      // Error counter should not be incremented for 2xx
      const errorsAfter = await httpErrorsTotal.get();
      expect(errorsAfter.values).toHaveLength(0);
    });

    it("should increment error counter for 4xx responses", async () => {
      const { recordRequestMetrics, httpRequestsTotal, httpErrorsTotal } =
        await import("@/lib/monitoring/metrics");

      httpRequestsTotal.reset();
      httpErrorsTotal.reset();

      recordRequestMetrics("POST", "/api/loans/apply", 400, 0.01);

      const errors = await httpErrorsTotal.get();
      expect(errors.values).toHaveLength(1);
      expect(errors.values[0].labels).toMatchObject({
        method: "POST",
        path: "/api/loans/apply",
        status_code: 400,
      });
      expect(errors.values[0].value).toBe(1);

      const requests = await httpRequestsTotal.get();
      expect(requests.values[0].value).toBe(1);
    });

    it("should increment error counter for 5xx responses", async () => {
      const { recordRequestMetrics, httpErrorsTotal } =
        await import("@/lib/monitoring/metrics");

      httpErrorsTotal.reset();

      recordRequestMetrics("GET", "/api/unknown", 503, 0.2);

      const errors = await httpErrorsTotal.get();
      expect(errors.values[0].labels).toMatchObject({
        method: "GET",
        path: "/api/unknown",
        status_code: 503,
      });
    });
  });

  describe("observeMemoryUsage", () => {
    it("should set all four memory gauge labels", async () => {
      const { observeMemoryUsage, processMemoryBytes } =
        await import("@/lib/monitoring/metrics");

      processMemoryBytes.reset();
      observeMemoryUsage();

      const gauge = await processMemoryBytes.get();
      const labels = gauge.values.map((v) => v.labels.memory_type);

      expect(labels).toContain("rss");
      expect(labels).toContain("heap_total");
      expect(labels).toContain("heap_used");
      expect(labels).toContain("external");

      // Each value should be a positive number
      for (const v of gauge.values) {
        expect(Number(v.value)).toBeGreaterThan(0);
      }
    });
  });

  describe("generateMetricsResponse", () => {
    it("should return a non-empty string in Prometheus text format", async () => {
      const { generateMetricsResponse } =
        await import("@/lib/monitoring/metrics");

      const output = await generateMetricsResponse();

      expect(typeof output).toBe("string");
      expect(output.length).toBeGreaterThan(0);

      // Should include at least one HELP line
      expect(output).toContain("# HELP");

      // Should include our custom metrics
      expect(output).toContain("http_requests_total");
      expect(output).toContain("process_memory_bytes");
    });
  });

  describe("withMetrics wrapper", () => {
    it("should record a successful request's duration and status", async () => {
      const { withMetrics, httpRequestsTotal, httpErrorsTotal, httpRequestDuration } =
        await import("@/lib/monitoring/metrics");

      httpRequestsTotal.reset();
      httpErrorsTotal.reset();
      httpRequestDuration.reset();

      const handler = vi.fn().mockResolvedValue(
        new Response("ok", { status: 200 }),
      );
      const wrapped = withMetrics(handler);

      const request = {
        method: "GET",
        nextUrl: { pathname: "/api/test" },
      };
      await wrapped(request as unknown as Request);

      expect(handler).toHaveBeenCalledTimes(1);

      const requests = await httpRequestsTotal.get();
      expect(requests.values[0].value).toBe(1);
      expect(requests.values[0].labels).toMatchObject({
        method: "GET",
        path: "/api/test",
        status: 200,
      });

      // Histogram should have recorded a duration
      const hist = await httpRequestDuration.get();
      expect(hist.values.length).toBeGreaterThan(0);
    });

    it("should propagate the response from the original handler", async () => {
      const { withMetrics } = await import("@/lib/monitoring/metrics");

      const handler = vi.fn().mockResolvedValue(
        new Response("hello", { status: 201 }),
      );
      const wrapped = withMetrics(handler);

      const response = await wrapped({} as unknown as Request);
      expect(response.status).toBe(201);
      expect(await response.text()).toBe("hello");
    });

    it("should record 500 when wrapped handler throws", async () => {
      const { withMetrics, httpRequestsTotal, httpErrorsTotal } =
        await import("@/lib/monitoring/metrics");

      httpRequestsTotal.reset();
      httpErrorsTotal.reset();

      const handler = vi.fn().mockRejectedValue(new Error("Kaboom"));
      const wrapped = withMetrics(handler);

      const request = {
        method: "POST",
        nextUrl: { pathname: "/api/error" },
      };

      await expect(
        wrapped(request as unknown as Request),
      ).rejects.toThrow("Kaboom");

      // Metrics should still be recorded
      const requests = await httpRequestsTotal.get();
      expect(requests.values[0].value).toBe(1);
      expect(requests.values[0].labels).toMatchObject({
        method: "POST",
        path: "/api/error",
        status: 500,
      });

      const errors = await httpErrorsTotal.get();
      expect(errors.values[0].value).toBe(1);
    });
  });
});
