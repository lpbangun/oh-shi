/** Cloudflare Worker entry point for OH SHI. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isPublicAgentRoute =
      url.pathname === "/llms.txt" ||
      url.pathname === "/agent-policy.json" ||
      url.pathname === "/robots.txt" ||
      url.pathname.startsWith("/api/v1/") ||
      url.pathname.startsWith("/exports/");

    if (request.method === "OPTIONS" && isPublicAgentRoute) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Cache-Control, If-None-Match",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    const isHomepageDocument =
      request.method === "GET" &&
      url.pathname === "/" &&
      url.search === "" &&
      request.headers.get("accept")?.includes("text/html") &&
      request.headers.get("rsc") !== "1";

    let response = await handler.fetch(request, env, ctx);
    if (isPublicAgentRoute) {
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Expose-Headers", "ETag, Content-Disposition");
      response = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (!isHomepageDocument || !response.ok) return response;

    // Sites Workers cannot access the edge Cache API. Advertise shared freshness
    // without making rendering depend on an unavailable runtime capability.
    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=0, s-maxage=300");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

export default worker;
