type ConditionalResponseOptions = {
  cacheControl: string;
  contentType: string;
  validator: string;
  headers?: Record<string, string>;
};

export async function weakEntityTag(validator: string) {
  const bytes = new TextEncoder().encode(validator);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `W/\"sha256-${hash}\"`;
}

export function requestMatchesEntityTag(request: Request, entityTag: string) {
  const supplied = request.headers.get("if-none-match");
  if (!supplied) return false;
  const normalized = (value: string) => value.trim().replace(/^W\//, "");
  return supplied.split(",").some((candidate) =>
    candidate.trim() === "*" || normalized(candidate) === normalized(entityTag)
  );
}

export async function conditionalResponse(
  request: Request,
  body: string,
  options: ConditionalResponseOptions
) {
  const entityTag = await weakEntityTag(options.validator);
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "ETag",
    "Cache-Control": options.cacheControl,
    "Content-Type": options.contentType,
    ETag: entityTag,
    ...options.headers,
  };
  if (requestMatchesEntityTag(request, entityTag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}

export function conditionalJsonResponse(
  request: Request,
  value: unknown,
  options: Omit<ConditionalResponseOptions, "contentType">
) {
  return conditionalResponse(request, JSON.stringify(value), {
    ...options,
    contentType: "application/json; charset=utf-8",
  });
}
