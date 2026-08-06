/** Cloudflare Worker entry point for OH SHI. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

declare const __DEPLOYED_SHA__: string;

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

    if (isHomepageDocument) {
      const edgeCache = (caches as unknown as { default: Cache }).default;
      const cacheUrl = new URL(request.url);
      cacheUrl.searchParams.set("__oh_shi_version", __DEPLOYED_SHA__);
      // The rendered public document is independent of browser-specific
      // Accept/Vary headers. A canonical internal key prevents needless cache
      // fragmentation while the deploy SHA keeps releases isolated.
      const cacheKey = new Request(cacheUrl.toString(), {
        headers: { accept: "text/html" },
      });
      const cached = await edgeCache.match(cacheKey);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set("x-oh-shi-cache", "HIT");
        return new Response(cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers,
        });
      }

      const response = await handler.fetch(request, env, ctx);
      if (response.ok) {
        const headers = new Headers(response.headers);
        headers.set("cache-control", "public, max-age=0, s-maxage=300");
        headers.set("x-oh-shi-cache", "MISS");
        const cacheable = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        ctx.waitUntil(edgeCache.put(cacheKey, cacheable.clone()));
        return cacheable;
      }
      return response;
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
